//! Plumbline pay-on-proof bounty.
//!
//! A sponsor escrows a reward against a test suite (`suite_commitment`) and a target accuracy
//! (`min_correct / min_total`). The reward is paid, permissionlessly, to the payout address proven
//! inside the score: the Plumbline registry holds a `VerifiedScore` only after it checked a Groth16
//! proof that a genuine TDX enclave running the approved compose signed the statement, and the
//! statement carries the entrant's `payout`. Nobody registers a payout, so nobody can squat one.
//!
//! Accounts:
//! - `Bounty` PDA ["bounty", sponsor, suite_commitment, nonce_le8]: the terms AND the lamport vault.
//!
//! The registry account is read directly (no CPI): owner must be `REGISTRY_PROGRAM_ID`, the first 8
//! bytes must be Anchor's `VerifiedScore` discriminator, and the address must be the canonical registry
//! PDA ["verified", statement_hash] for the statement hash stored inside it.
//!
//! Payment rule: the first score to meet the target gets the whole bounty (README: "best at deadline").

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_lang::system_program;

declare_id!("9mDieYQNR2L9xgaqS6LK26kxR26rA4R9UcFntG369RPf");

/// The Plumbline registry (plumbline/programs/registry `declare_id!`). A VerifiedScore is trusted only
/// if this program owns it.
pub const REGISTRY_PROGRAM_ID: Pubkey = pubkey!("Eicw3HXxXN7kckn5XB4WDGQG2c61BLf7X7QpGehLTgAW");
pub const REGISTRY_VERIFIED_SEED: &[u8] = b"verified";
pub const REGISTRY_SUITE_SEED: &[u8] = b"suite";

pub const BOUNTY_SEED: &[u8] = b"bounty";

pub const STATUS_OPEN: u8 = 0;
pub const STATUS_PAID: u8 = 1;

/// Anchor account discriminator: sha256("account:<Name>")[..8].
fn discriminator(name: &str) -> [u8; 8] {
    let h = hash(format!("account:{name}").as_bytes()).to_bytes();
    h[..8].try_into().unwrap()
}

/// Byte-for-byte mirror of the registry's `VerifiedScore` (field order matters: Borsh).
#[derive(AnchorDeserialize, Clone)]
pub struct RegistryVerifiedScore {
    pub statement_hash: [u8; 32],
    pub model_id_hash: [u8; 32],
    pub suite_commitment: [u8; 32],
    pub quote_hash: [u8; 32],
    pub mr_td: [u8; 48],
    pub rtmrs_hash: [u8; 32],
    pub tee_tcb_svn: [u8; 16],
    pub compose_hash: [u8; 32],
    pub correct: u32,
    pub total: u32,
    pub binding_version: u8,
    pub image_id: [u8; 32],
    pub suite_registered: bool,
    pub submitter: Pubkey,
    pub slot: u64,
    pub unix_timestamp: i64,
    pub payout: Pubkey,
    pub bump: u8,
}

/// Owner-, discriminator- and PDA-checked read of a registry VerifiedScore.
pub fn read_verified_score(info: &AccountInfo) -> Result<RegistryVerifiedScore> {
    require_keys_eq!(*info.owner, REGISTRY_PROGRAM_ID, BountyError::ScoreNotFromRegistry);
    let data = info.try_borrow_data()?;
    require!(
        data.len() >= 8 && data[..8] == discriminator("VerifiedScore"),
        BountyError::NotAVerifiedScore
    );
    let mut rest: &[u8] = &data[8..];
    let s = RegistryVerifiedScore::deserialize(&mut rest).map_err(|_| error!(BountyError::NotAVerifiedScore))?;
    let (canonical, _) =
        Pubkey::find_program_address(&[REGISTRY_VERIFIED_SEED, s.statement_hash.as_ref()], &REGISTRY_PROGRAM_ID);
    require_keys_eq!(canonical, info.key(), BountyError::BadScorePda);
    Ok(s)
}

/// correct/total >= min_correct/min_total without division (u32*u32 fits in u64), and the run must
/// cover at least min_total items.
pub fn meets_target(correct: u32, total: u32, min_correct: u32, min_total: u32) -> bool {
    total >= min_total && (correct as u64) * (min_total as u64) >= (min_correct as u64) * (total as u64)
}

#[program]
pub mod plumbline_bounty {
    use super::*;

    /// Escrow `amount` lamports for the first verified score on `suite_commitment` that reaches
    /// `min_correct / min_total` and was recorded at or before `deadline_slot`.
    /// `claim_grace_slots`: after the deadline the sponsor must wait this long before refunding, so a
    /// score recorded just before the deadline can still be claimed.
    /// `mint`: reserved for SPL (USDC); only `None` (lamports) is supported now.
    /// `require_registered_suite`: `suite` must be the registry's Suite PDA for this commitment.
    /// `required_compose_hash` / `required_image_id`: all zero = accept whatever the registry config
    /// accepted; non-zero = also pin the enclave compose / guest image, so a later registry config
    /// rotation cannot change what this bounty pays for.
    #[allow(clippy::too_many_arguments)]
    pub fn create_bounty(
        ctx: Context<CreateBounty>,
        nonce: u64,
        suite_commitment: [u8; 32],
        min_correct: u32,
        min_total: u32,
        amount: u64,
        deadline_slot: u64,
        claim_grace_slots: u64,
        mint: Option<Pubkey>,
        require_registered_suite: bool,
        required_compose_hash: [u8; 32],
        required_image_id: [u8; 32],
    ) -> Result<()> {
        require!(suite_commitment != [0u8; 32], BountyError::ZeroHash);
        require!(min_total > 0 && min_correct <= min_total, BountyError::BadTarget);
        require!(amount > 0, BountyError::ZeroAmount);
        require!(mint.is_none(), BountyError::MintNotSupported);
        let clock = Clock::get()?;
        require!(deadline_slot > clock.slot, BountyError::DeadlineInPast);
        require!(deadline_slot.checked_add(claim_grace_slots).is_some(), BountyError::DeadlineInPast);

        if require_registered_suite {
            let suite = ctx.accounts.suite.as_ref().ok_or(error!(BountyError::SuiteNotRegistered))?;
            require_keys_eq!(*suite.owner, REGISTRY_PROGRAM_ID, BountyError::SuiteNotRegistered);
            let (pda, _) =
                Pubkey::find_program_address(&[REGISTRY_SUITE_SEED, suite_commitment.as_ref()], &REGISTRY_PROGRAM_ID);
            require_keys_eq!(pda, suite.key(), BountyError::SuiteNotRegistered);
            let data = suite.try_borrow_data()?;
            require!(data.len() >= 8 && data[..8] == discriminator("Suite"), BountyError::SuiteNotRegistered);
        }

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.sponsor.to_account_info(),
                    to: ctx.accounts.bounty.to_account_info(),
                },
            ),
            amount,
        )?;

        let b = &mut ctx.accounts.bounty;
        b.sponsor = ctx.accounts.sponsor.key();
        b.nonce = nonce;
        b.suite_commitment = suite_commitment;
        b.min_correct = min_correct;
        b.min_total = min_total;
        b.amount = amount;
        b.mint = mint;
        b.deadline_slot = deadline_slot;
        b.claim_grace_slots = claim_grace_slots;
        b.require_registered_suite = require_registered_suite;
        b.required_compose_hash = required_compose_hash;
        b.required_image_id = required_image_id;
        b.created_slot = clock.slot;
        b.status = STATUS_OPEN;
        b.bump = ctx.bumps.bounty;
        emit!(BountyCreated {
            bounty: b.key(),
            sponsor: b.sponsor,
            suite_commitment,
            min_correct,
            min_total,
            amount,
            mint,
            deadline_slot,
            claim_grace_slots,
            require_registered_suite,
            slot: clock.slot,
        });
        Ok(())
    }

    /// Permissionless: anyone may crank it; the money can only go to the payout proven in the score.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let b = &ctx.accounts.bounty;
        require!(b.status == STATUS_OPEN, BountyError::AlreadyPaid);
        let s = read_verified_score(&ctx.accounts.verified_score)?;
        require!(s.suite_commitment == b.suite_commitment, BountyError::WrongSuite);
        require!(
            b.required_compose_hash == [0u8; 32] || s.compose_hash == b.required_compose_hash,
            BountyError::WrongEnclave
        );
        require!(
            b.required_image_id == [0u8; 32] || s.image_id == b.required_image_id,
            BountyError::WrongEnclave
        );
        require!(meets_target(s.correct, s.total, b.min_correct, b.min_total), BountyError::BelowTarget);
        require!(s.slot <= b.deadline_slot, BountyError::ScoreAfterDeadline);
        // a score recorded before the bounty existed cannot take it
        require!(s.slot >= b.created_slot, BountyError::ScoreBeforeBounty);
        require_keys_neq!(s.payout, Pubkey::default(), BountyError::NoPayout);
        require_keys_eq!(ctx.accounts.payout.key(), s.payout, BountyError::BadPayout);

        let amount = b.amount;
        let bounty_info = ctx.accounts.bounty.to_account_info();
        let payout_info = ctx.accounts.payout.to_account_info();
        let new_bounty = bounty_info.lamports().checked_sub(amount).unwrap();
        let new_payout = payout_info.lamports().checked_add(amount).unwrap();
        **bounty_info.try_borrow_mut_lamports()? = new_bounty;
        **payout_info.try_borrow_mut_lamports()? = new_payout;

        let clock = Clock::get()?;
        let payout = s.payout;
        let b = &mut ctx.accounts.bounty;
        b.status = STATUS_PAID;
        b.winner_statement_hash = s.statement_hash;
        b.winner_model_id_hash = s.model_id_hash;
        b.winner_payout = payout;
        b.paid_slot = clock.slot;
        emit!(BountyClaimed {
            bounty: b.key(),
            statement_hash: s.statement_hash,
            model_id_hash: s.model_id_hash,
            correct: s.correct,
            total: s.total,
            score_slot: s.slot,
            payout,
            amount,
            cranker: ctx.accounts.cranker.key(),
            slot: clock.slot,
        });
        Ok(())
    }

    /// Sponsor only, once `deadline_slot + claim_grace_slots` has passed and nothing was paid.
    /// Closes the bounty: escrow plus rent go back to the sponsor.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let b = &ctx.accounts.bounty;
        require!(b.status == STATUS_OPEN, BountyError::AlreadyPaid);
        let clock = Clock::get()?;
        require!(clock.slot > b.deadline_slot + b.claim_grace_slots, BountyError::RefundTooEarly);
        emit!(BountyRefunded {
            bounty: b.key(),
            sponsor: b.sponsor,
            amount: b.amount,
            returned_lamports: ctx.accounts.bounty.to_account_info().lamports(),
            slot: clock.slot,
        });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(nonce: u64, suite_commitment: [u8; 32])]
pub struct CreateBounty<'info> {
    #[account(
        init,
        payer = sponsor,
        space = 8 + Bounty::INIT_SPACE,
        seeds = [BOUNTY_SEED, sponsor.key().as_ref(), suite_commitment.as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub bounty: Account<'info, Bounty>,
    #[account(mut)]
    pub sponsor: Signer<'info>,
    /// CHECK: read only when `require_registered_suite`; owner, PDA and discriminator checked in the handler.
    pub suite: Option<UncheckedAccount<'info>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(
        mut,
        seeds = [BOUNTY_SEED, bounty.sponsor.as_ref(), bounty.suite_commitment.as_ref(), &bounty.nonce.to_le_bytes()],
        bump = bounty.bump,
    )]
    pub bounty: Account<'info, Bounty>,
    /// CHECK: the registry's VerifiedScore; owner, discriminator and PDA checked by `read_verified_score`.
    pub verified_score: UncheckedAccount<'info>,
    /// CHECK: must equal the score's proven payout (checked in the handler); only credited.
    #[account(mut)]
    pub payout: UncheckedAccount<'info>,
    /// Whoever submits the claim; receives nothing.
    pub cranker: Signer<'info>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(
        mut,
        seeds = [BOUNTY_SEED, bounty.sponsor.as_ref(), bounty.suite_commitment.as_ref(), &bounty.nonce.to_le_bytes()],
        bump = bounty.bump,
        has_one = sponsor @ BountyError::NotSponsor,
        close = sponsor,
    )]
    pub bounty: Account<'info, Bounty>,
    #[account(mut)]
    pub sponsor: Signer<'info>,
}

/// Terms and lamport vault in one PDA: lamports = rent + amount while open.
#[account]
#[derive(InitSpace)]
pub struct Bounty {
    pub sponsor: Pubkey,
    pub nonce: u64,
    pub suite_commitment: [u8; 32],
    pub min_correct: u32,
    pub min_total: u32,
    pub amount: u64,
    /// None = lamports. Some(mint) reserved for SPL (USDC), rejected for now.
    pub mint: Option<Pubkey>,
    pub deadline_slot: u64,
    pub claim_grace_slots: u64,
    pub require_registered_suite: bool,
    pub required_compose_hash: [u8; 32],
    pub required_image_id: [u8; 32],
    pub created_slot: u64,
    /// 0 = open, 1 = paid. (Refunded bounties are closed.)
    pub status: u8,
    pub winner_statement_hash: [u8; 32],
    pub winner_model_id_hash: [u8; 32],
    pub winner_payout: Pubkey,
    pub paid_slot: u64,
    pub bump: u8,
}

#[event]
pub struct BountyCreated {
    pub bounty: Pubkey,
    pub sponsor: Pubkey,
    pub suite_commitment: [u8; 32],
    pub min_correct: u32,
    pub min_total: u32,
    pub amount: u64,
    pub mint: Option<Pubkey>,
    pub deadline_slot: u64,
    pub claim_grace_slots: u64,
    pub require_registered_suite: bool,
    pub slot: u64,
}

#[event]
pub struct BountyClaimed {
    pub bounty: Pubkey,
    pub statement_hash: [u8; 32],
    pub model_id_hash: [u8; 32],
    pub correct: u32,
    pub total: u32,
    pub score_slot: u64,
    pub payout: Pubkey,
    pub amount: u64,
    pub cranker: Pubkey,
    pub slot: u64,
}

#[event]
pub struct BountyRefunded {
    pub bounty: Pubkey,
    pub sponsor: Pubkey,
    pub amount: u64,
    pub returned_lamports: u64,
    pub slot: u64,
}

#[error_code]
pub enum BountyError {
    #[msg("hash fields must not be all zero")]
    ZeroHash,
    #[msg("target must have min_total > 0 and min_correct <= min_total")]
    BadTarget,
    #[msg("amount must be > 0")]
    ZeroAmount,
    #[msg("only lamport bounties are supported (mint must be None)")]
    MintNotSupported,
    #[msg("deadline_slot must be in the future (and deadline + grace must not overflow)")]
    DeadlineInPast,
    #[msg("bounty requires the suite to be registered in the sealed-eval registry")]
    SuiteNotRegistered,
    #[msg("payout account must be the payout proven in the score")]
    BadPayout,
    #[msg("bounty is already paid")]
    AlreadyPaid,
    #[msg("score account is not owned by the sealed-eval registry")]
    ScoreNotFromRegistry,
    #[msg("account is not a registry VerifiedScore")]
    NotAVerifiedScore,
    #[msg("score account is not the registry PDA [verified, statement_hash]")]
    BadScorePda,
    #[msg("score is for a different suite")]
    WrongSuite,
    #[msg("score came from a different enclave compose / guest image than the bounty pins")]
    WrongEnclave,
    #[msg("score is below the bounty target")]
    BelowTarget,
    #[msg("score was recorded after the bounty deadline")]
    ScoreAfterDeadline,
    #[msg("score was recorded before the bounty was created")]
    ScoreBeforeBounty,
    #[msg("score carries no payout address (statement without payout)")]
    NoPayout,
    #[msg("refund only after deadline_slot + claim_grace_slots")]
    RefundTooEarly,
    #[msg("only the sponsor can refund")]
    NotSponsor,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_cross_multiplication() {
        assert!(meets_target(4, 6, 2, 3)); // exactly equal counts as meeting the target
        assert!(meets_target(4, 6, 4, 6));
        assert!(!meets_target(4, 6, 5, 6));
        assert!(meets_target(667, 1000, 2, 3));
        assert!(!meets_target(666, 1000, 2, 3)); // 1998 < 2000
        assert!(meets_target(u32::MAX, u32::MAX, u32::MAX, u32::MAX)); // no overflow in u64
        assert!(!meets_target(1, 1, 9, 10)); // a 1-item run cannot meet a 10-item floor
    }

    #[test]
    fn verified_score_discriminator_is_anchors() {
        // sha256("account:VerifiedScore")[..8], as in the registry IDL.
        assert_eq!(discriminator("VerifiedScore"), [0xbf, 0xf9, 0xb5, 0x94, 0x45, 0x03, 0x01, 0xde]);
    }

    #[test]
    fn verified_score_mirror_is_the_registry_layout() {
        // registry VerifiedScore: 8 discriminator + 379 bytes of fields (InitSpace), payout at 346..378
        let mut data = vec![0u8; 379];
        data[346..378].copy_from_slice(&[7u8; 32]);
        data[378] = 254;
        let s = RegistryVerifiedScore::deserialize(&mut &data[..]).unwrap();
        assert_eq!(s.payout, Pubkey::new_from_array([7u8; 32]));
        assert_eq!(s.bump, 254);
    }

    #[test]
    fn registry_id_is_pinned() {
        assert_eq!(REGISTRY_PROGRAM_ID.to_string(), "Eicw3HXxXN7kckn5XB4WDGQG2c61BLf7X7QpGehLTgAW");
    }
}
