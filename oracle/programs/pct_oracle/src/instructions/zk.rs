//! Private covenant: one RISC Zero Groth16 proof says "this H100 is genuine (NVIDIA-signed report with
//! the lender's challenge as nonce), it sits inside this measured Intel TDX VM (quote chained to
//! Intel's root, vouching for that exact report), and this operator's revenue over the covenant
//! window covers debt service by X". The proof is checked here; amounts, payment ids and the GPU report never
//! go onchain. The guest is zk/risc0/methods/guest; its journal layout is zk/lib `public_values`.

use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::OracleError,
    instructions::registry::{bind_device, claim_nonce, registry_enforced, require_nonce_claimed_by, Pledge},
    reclaim::keccak,
    risc0_groth16,
    state::*,
};

pub const ZK_CONFIG_SEED: &[u8] = b"zk_config";
pub const ZK_COVENANT_SEED: &[u8] = b"zk_covenant";
pub const TREASURY_SEED: &[u8] = b"treasury";
const PUBLIC_VALUES_LEN: usize = 6 * 32 + 8 + 8 + 4 + 1 + 32 + 16 + 1;

pub const ZK_NONE: u8 = 0;
pub const ZK_PASS: u8 = 1;
pub const ZK_WATCH: u8 = 2;

/// Which guest program (RISC Zero image id) the oracle accepts, and how many attestors must sign
/// each revenue claim inside it.
#[account]
#[derive(InitSpace)]
pub struct ZkConfig {
    pub image_id: [u8; 32],
    pub attestor_threshold: u8,
    /// Refuse proofs whose TDX quote does not vouch for the exact GPU report and challenge.
    pub require_vm_bound: bool,
    /// Only accept this VM image + runtime (sha256(mr_td || rtmrs hash)); all zero = any.
    pub vm_measurement: [u8; 32],
    pub bump: u8,
    /// Charged to the submitter on every proof, PASS or WATCH (the proving work was done either way); 0 = free.
    pub fee_lamports: u64,
}

/// Holds the proof fees until the authority withdraws them.
#[account]
#[derive(InitSpace)]
pub struct Treasury {
    pub bump: u8,
}

/// Latest private covenant result for one loan.
#[account]
#[derive(InitSpace)]
pub struct ZkCovenant {
    pub loan: Pubkey,
    /// Nonce the lender asked the GPU to sign; a report with any other nonce is refused.
    pub gpu_challenge: [u8; 32],
    pub status: u8,
    pub coverage_bps: u64,
    pub as_of_period: u32,
    pub claims: u32,
    /// sha256 of the GPU's per-chip id, and of its signed firmware measurements.
    pub chip_id: [u8; 32],
    pub measurements: [u8; 32],
    /// The confidential VM the TDX quote measured, and whether it vouched for this GPU report.
    pub vm_measurement: [u8; 32],
    pub vm_bound: bool,
    pub proven_at: i64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct SetZkConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ OracleError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(init_if_needed, payer = authority, space = 8 + ZkConfig::INIT_SPACE, seeds = [ZK_CONFIG_SEED], bump)]
    pub zk_config: Account<'info, ZkConfig>,
    pub system_program: Program<'info, System>,
}

pub fn handle_set_zk_config(
    ctx: Context<SetZkConfig>,
    image_id: [u8; 32],
    attestor_threshold: u8,
    require_vm_bound: bool,
    vm_measurement: [u8; 32],
) -> Result<()> {
    require!(attestor_threshold >= 1 && attestor_threshold as usize <= ctx.accounts.config.attestors.len(), OracleError::BadZkConfig);
    // Any TDX VM can write any report_data, so "the VM vouched for this GPU report" only means
    // something for a pinned image known to write it honestly.
    require!(!require_vm_bound || vm_measurement != [0u8; 32], OracleError::BadZkConfig);
    let z = &mut ctx.accounts.zk_config;
    z.image_id = image_id;
    z.attestor_threshold = attestor_threshold;
    z.require_vm_bound = require_vm_bound;
    z.vm_measurement = vm_measurement;
    z.bump = ctx.bumps.zk_config;
    Ok(())
}

#[derive(Accounts)]
pub struct IssueGpuChallenge<'info> {
    #[account(mut)]
    pub lender: Signer<'info>,
    #[account(seeds = [LOAN_SEED, loan.lender.as_ref(), loan.operator_key.as_ref()], bump = loan.bump, has_one = lender @ OracleError::NotLender)]
    pub loan: Account<'info, Loan>,
    #[account(init_if_needed, payer = lender, space = 8 + ZkCovenant::INIT_SPACE, seeds = [ZK_COVENANT_SEED, loan.key().as_ref()], bump)]
    pub zk_covenant: Account<'info, ZkCovenant>,
    pub system_program: Program<'info, System>,
    // remaining_accounts[0] (optional): the writable NonceClaim PDA ["nonce", challenge]. Passing it
    // claims the nonce for this loan (NonceTaken if another loan holds it). While the device
    // registry is enforced, prove_covenant only binds a GPU with a nonce its loan claimed, so a
    // lender using the registry passes it here, in the same instruction that reveals the nonce.
}

/// The lender picks the nonce the operator's GPU must sign (any fresh random 32 bytes).
pub fn handle_issue_gpu_challenge<'info>(ctx: Context<'info, IssueGpuChallenge<'info>>, challenge: [u8; 32]) -> Result<()> {
    let loan = ctx.accounts.loan.key();
    if let Some(claim) = ctx.remaining_accounts.first() {
        claim_nonce(claim, &ctx.accounts.lender.to_account_info(), &challenge, loan)?;
    }
    let z = &mut ctx.accounts.zk_covenant;
    z.loan = loan;
    z.gpu_challenge = challenge;
    z.bump = ctx.bumps.zk_covenant;
    Ok(())
}

#[derive(Accounts)]
pub struct ProveCovenant<'info> {
    #[account(mut)]
    pub submitter: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [ZK_CONFIG_SEED], bump = zk_config.bump)]
    pub zk_config: Account<'info, ZkConfig>,
    /// The registered revenue source every claim in the proof must come from.
    #[account(seeds = [SOURCE_SEED, source.source_id.as_ref()], bump = source.bump)]
    pub source: Account<'info, PriceSource>,
    #[account(seeds = [LOAN_SEED, loan.lender.as_ref(), loan.operator_key.as_ref()], bump = loan.bump)]
    pub loan: Account<'info, Loan>,
    #[account(mut, seeds = [ZK_COVENANT_SEED, loan.key().as_ref()], bump = zk_covenant.bump, has_one = loan)]
    pub zk_covenant: Account<'info, ZkCovenant>,
    /// CHECK: the fee treasury by address; it only has to exist once a fee is set (set_proof_fee creates it).
    #[account(mut, seeds = [TREASURY_SEED], bump)]
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    // remaining_accounts[0]: the RegistryConfig PDA ["registry_config"], always, initialised or not
    //   (any other account fails, so leaving it out cannot skip enforcement).
    // While it enforces the registry:
    //   remaining_accounts[1]: the writable Device PDA ["device", chip_id];
    //   remaining_accounts[2]: the NonceClaim PDA ["nonce", journal nonce], claimed by this loan.
}

#[event]
pub struct CovenantProven {
    pub loan: Pubkey,
    pub status: u8,
    pub coverage_bps: u64,
    pub as_of_period: u32,
    pub claims: u32,
    pub chip_id: [u8; 32],
    pub vm_measurement: [u8; 32],
    pub vm_bound: bool,
    pub fee_lamports: u64,
}

/// The terms hash the guest commits to; must match zk/lib `Terms::hash`.
pub fn terms_hash(loan: &Loan, as_of_period: u32) -> [u8; 32] {
    let mut b = Vec::with_capacity(32 + 3 + 4 + 8 + 4 + 1 + 4);
    b.extend_from_slice(&loan.operator_key);
    b.extend_from_slice(&loan.currency);
    b.extend_from_slice(&loan.period_s.to_le_bytes());
    b.extend_from_slice(&loan.debt_service_micro.to_le_bytes());
    b.extend_from_slice(&(loan.min_coverage_bps as u32).to_le_bytes());
    b.push(loan.covenant_periods);
    b.extend_from_slice(&as_of_period.to_le_bytes());
    keccak(&b)
}

/// keccak(threshold | attestor addresses in config order); must match zk/lib `AttestorSet::hash`.
pub fn attestor_set_hash(threshold: u8, attestors: &[[u8; 20]]) -> [u8; 32] {
    let mut b = vec![threshold];
    for a in attestors {
        b.extend_from_slice(a);
    }
    keccak(&b)
}

pub fn handle_prove_covenant<'info>(
    ctx: Context<'info, ProveCovenant<'info>>,
    seal: Vec<u8>,
    public_values: Vec<u8>,
    as_of_period: u32,
) -> Result<()> {
    let zk = &ctx.accounts.zk_config;
    let fee_lamports = zk.fee_lamports;
    if fee_lamports > 0 {
        let cpi = anchor_lang::system_program::Transfer {
            from: ctx.accounts.submitter.to_account_info(),
            to: ctx.accounts.treasury.to_account_info(),
        };
        anchor_lang::system_program::transfer(CpiContext::new(ctx.accounts.system_program.key(), cpi), fee_lamports)?;
    }
    risc0_groth16::verify(&seal, &zk.image_id, &public_values).map_err(|e| {
        msg!("groth16: {:?}", e);
        error!(OracleError::BadZkProof)
    })?;
    require!(public_values.len() == PUBLIC_VALUES_LEN, OracleError::BadZkProof);
    let word = |i: usize| -> [u8; 32] { public_values[i * 32..(i + 1) * 32].try_into().unwrap() };
    let (chip_id, nonce, measurements) = (word(0), word(1), word(2));
    let tail = &public_values[192..];
    let coverage_bps = u64::from_le_bytes(tail[8..16].try_into().unwrap());
    let claims = u32::from_le_bytes(tail[16..20].try_into().unwrap());
    let pass = tail[20] == 1;
    let vm_measurement: [u8; 32] = tail[21..53].try_into().unwrap();
    let vm_bound = tail[69] == 1;
    require!(vm_bound || !zk.require_vm_bound, OracleError::ZkVmNotBound);
    require!(zk.vm_measurement == [0u8; 32] || zk.vm_measurement == vm_measurement, OracleError::ZkVmNotBound);

    let config = &ctx.accounts.config;
    let source = &ctx.accounts.source;
    let loan = &ctx.accounts.loan;
    // The guest accepts GH100 reports only (H100, H200); a B200 loan cannot be backed by one.
    require!(loan.sku <= 1, OracleError::GpuSkuMismatch);
    let z = &mut ctx.accounts.zk_covenant;
    require!(nonce != [0u8; 32] && nonce == z.gpu_challenge, OracleError::ZkStaleChallenge);
    require!(word(3) == attestor_set_hash(zk.attestor_threshold, &config.attestors), OracleError::ZkAttestorMismatch);
    require!(source.kind == KIND_REVENUE && source.active, OracleError::WrongSourceKind);
    require!(word(4) == source.params_hash, OracleError::ParamsMismatch);
    require!(word(5) == terms_hash(loan, as_of_period), OracleError::ZkTermsMismatch);

    // The window must end in the current or previous period, and results only move forward.
    let now = Clock::get()?.unix_timestamp;
    let current = loan.period_of(now);
    require!(as_of_period <= current && as_of_period + 1 >= current, OracleError::NoRecentRevenue);
    require!(z.status == ZK_NONE || as_of_period >= z.as_of_period, OracleError::RevenueTooOld);

    let extra = ctx.remaining_accounts;
    if registry_enforced(extra.first())? {
        let device = extra.get(1).ok_or(error!(OracleError::BadDeviceAccount))?;
        let pledge = Pledge { chip_id, loan: loan.key(), lender: loan.lender, now, period: as_of_period };
        bind_device(device, &ctx.accounts.submitter.to_account_info(), &pledge)?;
        // The journal names the terms, not the loan: only the loan that claimed this nonce may bind with it.
        require_nonce_claimed_by(extra.get(2), &nonce, loan.key())?;
    }

    z.status = if pass { ZK_PASS } else { ZK_WATCH };
    z.coverage_bps = coverage_bps;
    z.as_of_period = as_of_period;
    z.claims = claims;
    z.chip_id = chip_id;
    z.measurements = measurements;
    z.vm_measurement = vm_measurement;
    z.vm_bound = vm_bound;
    z.proven_at = now;
    // One proof per challenge: the same proof (or any other made for this nonce) cannot be replayed.
    z.gpu_challenge = [0u8; 32];
    emit!(CovenantProven { loan: loan.key(), status: z.status, coverage_bps, as_of_period, claims, chip_id, vm_measurement, vm_bound, fee_lamports });
    Ok(())
}

#[derive(Accounts)]
pub struct SetProofFee<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ OracleError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [ZK_CONFIG_SEED], bump = zk_config.bump)]
    pub zk_config: Account<'info, ZkConfig>,
    #[account(init_if_needed, payer = authority, space = 8 + Treasury::INIT_SPACE, seeds = [TREASURY_SEED], bump)]
    pub treasury: Account<'info, Treasury>,
    pub system_program: Program<'info, System>,
}

pub fn handle_set_proof_fee(ctx: Context<SetProofFee>, fee_lamports: u64) -> Result<()> {
    ctx.accounts.zk_config.fee_lamports = fee_lamports;
    ctx.accounts.treasury.bump = ctx.bumps.treasury;
    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ OracleError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
}

/// Moves collected fees to the authority, keeping the treasury rent-exempt.
pub fn handle_withdraw_fees(ctx: Context<WithdrawFees>, lamports: u64) -> Result<()> {
    let treasury = ctx.accounts.treasury.to_account_info();
    let floor = Rent::get()?.minimum_balance(treasury.data_len());
    require!(treasury.lamports().saturating_sub(floor) >= lamports, OracleError::InsufficientFees);
    **treasury.try_borrow_mut_lamports()? -= lamports;
    **ctx.accounts.authority.to_account_info().try_borrow_mut_lamports()? += lamports;
    Ok(())
}

#[derive(Accounts)]
pub struct DrawPrivate<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(mut, seeds = [LOAN_SEED, loan.lender.as_ref(), loan.operator_key.as_ref()], bump = loan.bump, has_one = borrower @ OracleError::NotBorrower)]
    pub loan: Account<'info, Loan>,
    #[account(seeds = [ZK_COVENANT_SEED, loan.key().as_ref()], bump = zk_covenant.bump, has_one = loan)]
    pub zk_covenant: Account<'info, ZkCovenant>,
}

/// Draw gated on the private covenant: allowed only while the latest proof says PASS and covers
/// the current or previous period.
pub fn handle_draw_private(ctx: Context<DrawPrivate>, lamports: u64) -> Result<()> {
    let z = &ctx.accounts.zk_covenant;
    let now = Clock::get()?.unix_timestamp;
    let current = ctx.accounts.loan.period_of(now);
    require!(z.status != ZK_NONE && z.as_of_period + 1 >= current, OracleError::NoRecentRevenue);
    require!(z.status == ZK_PASS, OracleError::CovenantBreached);

    let loan_info = ctx.accounts.loan.to_account_info();
    let rent_floor = Rent::get()?.minimum_balance(loan_info.data_len());
    let available = loan_info.lamports().saturating_sub(rent_floor);
    require!(lamports <= available, OracleError::InsufficientFunds);
    **loan_info.try_borrow_mut_lamports()? -= lamports;
    **ctx.accounts.borrower.to_account_info().try_borrow_mut_lamports()? += lamports;
    let coverage_bps = z.coverage_bps;
    let loan = &mut ctx.accounts.loan;
    loan.drawn_lamports = loan.drawn_lamports.saturating_add(lamports);
    emit!(crate::instructions::lending::DrawApproved { loan: loan.key(), lamports, coverage_bps });
    Ok(())
}
