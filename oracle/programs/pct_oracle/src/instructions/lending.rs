use anchor_lang::{prelude::*, system_program};

use crate::{
    constants::*,
    error::OracleError,
    instructions::submit::{verify_claim, ClaimSig},
    reclaim,
    state::*,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct LoanTerms {
    pub operator_key: [u8; 32],
    pub borrower: Pubkey,
    pub sku: u8,
    pub fleet_gpus: u16,
    pub period_s: u32,
    pub debt_service_micro: u64,
    pub min_coverage_bps: u16,
}

#[derive(Accounts)]
#[instruction(terms: LoanTerms)]
pub struct OpenLoan<'info> {
    #[account(mut)]
    pub lender: Signer<'info>,
    #[account(init, payer = lender, space = 8 + Loan::INIT_SPACE, seeds = [LOAN_SEED, terms.operator_key.as_ref()], bump)]
    pub loan: Account<'info, Loan>,
    pub system_program: Program<'info, System>,
}

/// A lender opens a facility for an operator it has identified off-chain, keyed by the hashed
/// account id that operator's revenue proofs will reveal.
pub fn handle_open_loan(ctx: Context<OpenLoan>, terms: LoanTerms) -> Result<()> {
    require!(
        terms.sku < SKU_COUNT && terms.fleet_gpus > 0 && terms.period_s >= 3_600 && terms.debt_service_micro > 0,
        OracleError::BadLoanTerms
    );
    ctx.accounts.loan.set_inner(Loan {
        lender: ctx.accounts.lender.key(),
        borrower: terms.borrower,
        operator_key: terms.operator_key,
        sku: terms.sku,
        fleet_gpus: terms.fleet_gpus,
        period_s: terms.period_s,
        debt_service_micro: terms.debt_service_micro,
        min_coverage_bps: terms.min_coverage_bps,
        drawn_lamports: 0,
        history: [PeriodRevenue::default(); LOAN_HISTORY],
        updated_at: 0,
        bump: ctx.bumps.loan,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct FundLoan<'info> {
    #[account(mut)]
    pub lender: Signer<'info>,
    #[account(mut, seeds = [LOAN_SEED, loan.operator_key.as_ref()], bump = loan.bump, has_one = lender @ OracleError::Unauthorized)]
    pub loan: Account<'info, Loan>,
    pub system_program: Program<'info, System>,
}

pub fn handle_fund_loan(ctx: Context<FundLoan>, lamports: u64) -> Result<()> {
    let cpi = system_program::Transfer { from: ctx.accounts.lender.to_account_info(), to: ctx.accounts.loan.to_account_info() };
    system_program::transfer(CpiContext::new(ctx.accounts.system_program.key(), cpi), lamports)
}

#[derive(Accounts)]
#[instruction(sig: ClaimSig)]
pub struct SubmitRevenue<'info> {
    #[account(mut)]
    pub submitter: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        seeds = [SOURCE_SEED, source.source_id.as_ref()],
        bump = source.bump,
        constraint = source.kind == KIND_REVENUE @ OracleError::BadSourceShape
    )]
    pub source: Account<'info, PriceSource>,
    #[account(mut, seeds = [LOAN_SEED, loan.operator_key.as_ref()], bump = loan.bump)]
    pub loan: Box<Account<'info, Loan>>,
    /// The paid price tape for the loan's SKU: realized rent from proofs with hours lands here.
    #[account(
        mut,
        seeds = [BOOK_SEED, &[loan.sku], &[KIND_PAID]],
        bump = book.bump
    )]
    pub book: Box<Account<'info, Book>>,
    #[account(
        mut,
        seeds = [BUFFER_SEED, submitter.key().as_ref()],
        bump,
        constraint = buffer.authority == submitter.key() @ OracleError::BadBuffer,
        close = submitter
    )]
    pub buffer: Box<Account<'info, ClaimBuffer>>,
    /// One proof per source, operator and loan period.
    #[account(
        init,
        payer = submitter,
        space = 8 + Receipt::INIT_SPACE,
        seeds = [RECEIPT_SEED, source.key().as_ref(), &revenue_receipt_key(&loan.operator_key, loan.period_of(sig.timestamp_s as i64))],
        bump
    )]
    pub receipt: Account<'info, Receipt>,
    pub system_program: Program<'info, System>,
}

pub fn revenue_receipt_key(operator_key: &[u8; 32], period: u32) -> [u8; 32] {
    let mut bytes = [0u8; 36];
    bytes[..32].copy_from_slice(operator_key);
    bytes[32..].copy_from_slice(&period.to_le_bytes());
    reclaim::keccak(&bytes)
}

#[event]
pub struct RevenueProven {
    pub loan: Pubkey,
    pub source: Pubkey,
    pub provider_id: u16,
    pub period: u32,
    pub revenue_micro: u64,
    pub gpu_hours_micro: u64,
    /// Realized rent per GPU-hour, 0 when the proof carries no hours.
    pub rent_micro: u64,
    /// This period's proven revenue over debt service so far.
    pub period_coverage_bps: u64,
    /// The covenant figure: trailing-quarter revenue over debt service, as of the latest period.
    pub trailing_coverage_bps: u64,
    pub observed_at: i64,
    pub identifier: [u8; 32],
}

/// Anyone may submit an operator's revenue proof: it is self-authenticating and only counts
/// toward the loan whose operator_key matches the proof's hashed account id.
pub fn handle_submit_revenue(ctx: Context<SubmitRevenue>, sig: ClaimSig) -> Result<()> {
    let source = &ctx.accounts.source;
    let (provider, parameters, context) = ctx.accounts.buffer.parts().ok_or(OracleError::BadBuffer)?;
    let identifier = verify_claim(&ctx.accounts.config, source, provider, parameters, context, &sig)?;

    let account = reclaim::extract_param(context, "account").map_err(OracleError::from)?;
    let loan = &mut ctx.accounts.loan;
    require!(reclaim::keccak(account) == loan.operator_key, OracleError::OperatorMismatch);

    let revenue = reclaim::parse_micro(reclaim::extract_param(context, "amount").map_err(OracleError::from)?).map_err(OracleError::from)?;
    require!(revenue > 0, OracleError::BadNumber);
    let hours = match reclaim::extract_param(context, "hours") {
        Ok(raw) => reclaim::parse_micro(raw).map_err(OracleError::from)?,
        Err(_) => 0,
    };

    let observed_at = sig.timestamp_s as i64;
    let period = loan.period_of(observed_at);
    loan.record(period, revenue, hours);
    loan.updated_at = observed_at;
    let this_period = loan.history.iter().find(|p| p.proofs > 0 && p.period == period).copied().unwrap_or_default();
    let period_coverage_bps = loan.coverage_bps(&this_period);
    let trailing_coverage_bps = loan.latest().map(|l| loan.trailing_coverage_bps(l.period)).unwrap_or(0);

    // GPU-hours are already per GPU, so realized rent is amount / hours.
    let rent = if hours > 0 { reclaim::div_round(revenue as u128 * 1_000_000, hours as u128) } else { 0 };
    if rent > 0 {
        ctx.accounts.book.push(Slot { provider_id: source.provider_id, price_micro: rent, observed_at, weight: 1 });
    }
    ctx.accounts.receipt.set_inner(Receipt { source: source.key(), observed_at });
    emit!(RevenueProven {
        loan: loan.key(),
        source: source.key(),
        provider_id: source.provider_id,
        period,
        revenue_micro: revenue,
        gpu_hours_micro: hours,
        rent_micro: rent,
        period_coverage_bps,
        trailing_coverage_bps,
        observed_at,
        identifier,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Draw<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(mut, seeds = [LOAN_SEED, loan.operator_key.as_ref()], bump = loan.bump, has_one = borrower @ OracleError::NotBorrower)]
    pub loan: Account<'info, Loan>,
}

#[event]
pub struct DrawApproved {
    pub loan: Pubkey,
    pub lamports: u64,
    pub coverage_bps: u64,
}

/// Toy facility: the borrower can draw undrawn funds only while proven revenue covers debt
/// service at the loan's minimum coverage ratio.
pub fn handle_draw(ctx: Context<Draw>, lamports: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let coverage_bps = ctx.accounts.loan.covenant(now).map_err(|f| match f {
        CovenantFailure::NoRecentRevenue => error!(OracleError::NoRecentRevenue),
        CovenantFailure::Breached(c) => {
            msg!("coverage {} bps < required {} bps", c, ctx.accounts.loan.min_coverage_bps);
            error!(OracleError::CovenantBreached)
        }
    })?;

    let loan_info = ctx.accounts.loan.to_account_info();
    let rent_floor = Rent::get()?.minimum_balance(loan_info.data_len());
    let available = loan_info.lamports().saturating_sub(rent_floor);
    require!(lamports <= available, OracleError::InsufficientFunds);
    **loan_info.try_borrow_mut_lamports()? -= lamports;
    **ctx.accounts.borrower.to_account_info().try_borrow_mut_lamports()? += lamports;

    let loan = &mut ctx.accounts.loan;
    loan.drawn_lamports = loan.drawn_lamports.saturating_add(lamports);
    emit!(DrawApproved { loan: loan.key(), lamports, coverage_bps });
    Ok(())
}
