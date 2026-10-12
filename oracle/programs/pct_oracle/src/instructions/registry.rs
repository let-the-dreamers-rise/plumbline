//! Cross-lender GPU device registry: one `Device` PDA per GPU (seeded by the chip id the covenant
//! proof commits to), recording the loan it is pledged to. While the `RegistryConfig` PDA says
//! enforce, a covenant proof for a GPU already pledged to another loan (of any lender) is refused,
//! so the same card cannot back two loans.
//!
//! Replay: the journal binds the loan terms and the challenge nonce, not the loan itself, so a
//! second lender could open a loan with identical terms, issue the victim's nonce and replay the
//! victim's proof. While enforcing, each nonce is therefore claimed once, globally, by a
//! `NonceClaim` PDA at ["nonce", nonce] created with the challenge (`issue_gpu_challenge`), and
//! `prove_covenant` only binds the GPU when that claim belongs to the loan being proven.
//!
//! The flag lives in its own PDA (not in `ZkConfig`, whose layout stays as deployed). Every
//! `prove_covenant` passes the RegistryConfig address as remaining account 0, initialised or not,
//! so a caller cannot skip enforcement by leaving it out.

use anchor_lang::{prelude::*, system_program};

use crate::{
    constants::*,
    error::OracleError,
    instructions::zk::{ZkCovenant, ZK_COVENANT_SEED, ZK_NONE},
    state::{Config, Loan},
};

pub const DEVICE_SEED: &[u8] = b"device";
pub const NONCE_SEED: &[u8] = b"nonce";
pub const REGISTRY_CONFIG_SEED: &[u8] = b"registry_config";

#[account]
#[derive(InitSpace)]
pub struct Device {
    /// sha256 of the GPU's per-chip id (journal word 0).
    pub chip_id: [u8; 32],
    /// Loan the GPU is pledged to; `Pubkey::default()` while free.
    pub loan: Pubkey,
    /// That loan's lender (one of the keys that can release the pledge).
    pub lender: Pubkey,
    pub first_seen_at: i64,
    pub first_seen_period: u32,
    pub bound_at: i64,
    pub bound_period: u32,
    pub bump: u8,
}

/// Whether `prove_covenant` enforces the device registry. Absent = off.
#[account]
#[derive(InitSpace)]
pub struct RegistryConfig {
    pub enforce: bool,
    pub bump: u8,
}

/// A GPU challenge nonce, claimed by the one loan allowed to bind a device with it.
#[account]
#[derive(InitSpace)]
pub struct NonceClaim {
    pub nonce: [u8; 32],
    pub loan: Pubkey,
    pub claimed_at: i64,
    pub bump: u8,
}

#[event]
pub struct DeviceBound {
    pub chip_id: [u8; 32],
    pub loan: Pubkey,
    pub lender: Pubkey,
}

#[event]
pub struct DeviceReleased {
    pub chip_id: [u8; 32],
    pub loan: Pubkey,
    pub lender: Pubkey,
    /// Who released it: the lender, the loan's borrower or the config authority.
    pub by: Pubkey,
}

#[event]
pub struct DeviceRegistryToggled {
    pub enforce: bool,
    pub authority: Pubkey,
}

#[derive(Accounts)]
pub struct SetDeviceRegistry<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ OracleError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(init_if_needed, payer = authority, space = 8 + RegistryConfig::INIT_SPACE, seeds = [REGISTRY_CONFIG_SEED], bump)]
    pub registry_config: Account<'info, RegistryConfig>,
    pub system_program: Program<'info, System>,
}

pub fn handle_set_device_registry(ctx: Context<SetDeviceRegistry>, enforce: bool) -> Result<()> {
    let r = &mut ctx.accounts.registry_config;
    r.enforce = enforce;
    r.bump = ctx.bumps.registry_config;
    emit!(DeviceRegistryToggled { enforce, authority: ctx.accounts.authority.key() });
    Ok(())
}

#[derive(Accounts)]
pub struct ReleaseDevice<'info> {
    pub releaser: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [DEVICE_SEED, device.chip_id.as_ref()],
        bump = device.bump,
        constraint = device.loan != Pubkey::default() @ OracleError::DeviceNotPledged,
    )]
    pub device: Account<'info, Device>,
    /// The loan the GPU is pledged to (for its borrower).
    #[account(address = device.loan @ OracleError::BadDeviceAccount)]
    pub loan: Account<'info, Loan>,
    /// That loan's private covenant, reset to NONE: a released GPU no longer backs it.
    #[account(mut, seeds = [ZK_COVENANT_SEED, loan.key().as_ref()], bump = zk_covenant.bump, has_one = loan)]
    pub zk_covenant: Account<'info, ZkCovenant>,
}

/// Frees the GPU (loan repaid or closed) so it can be pledged again. Allowed for the bound loan's
/// lender, its borrower, or the config authority (recovery when a lender key is lost or idle).
/// The loan's covenant drops to NONE, so a borrower cannot free the GPU, pledge it to another loan
/// and keep drawing on this one with the old PASS; this loan needs a new proof (and the GPU) to draw.
pub fn handle_release_device(ctx: Context<ReleaseDevice>) -> Result<()> {
    let by = ctx.accounts.releaser.key();
    let d = &mut ctx.accounts.device;
    let allowed = by == d.lender || by == ctx.accounts.loan.borrower || by == ctx.accounts.config.authority;
    require!(allowed, OracleError::CannotReleaseDevice);
    emit!(DeviceReleased { chip_id: d.chip_id, loan: d.loan, lender: d.lender, by });
    d.loan = Pubkey::default();
    d.lender = Pubkey::default();
    ctx.accounts.zk_covenant.status = ZK_NONE;
    Ok(())
}

/// Reads the registry flag from `info`, which must be the RegistryConfig PDA (initialised or not).
/// Any other account fails, so omitting or swapping it cannot turn enforcement off.
pub fn registry_enforced(info: Option<&AccountInfo>) -> Result<bool> {
    let info = info.ok_or(error!(OracleError::BadRegistryConfig))?;
    if info.owner != &crate::ID {
        // Never initialised (only the program can create an account at its PDA): off.
        let (expected, _) = Pubkey::find_program_address(&[REGISTRY_CONFIG_SEED], &crate::ID);
        require_keys_eq!(info.key(), expected, OracleError::BadRegistryConfig);
        return Ok(false);
    }
    let r = RegistryConfig::try_deserialize(&mut &info.try_borrow_data()?[..]).map_err(|_| error!(OracleError::BadRegistryConfig))?;
    let expected = Pubkey::create_program_address(&[REGISTRY_CONFIG_SEED, &[r.bump]], &crate::ID)
        .map_err(|_| error!(OracleError::BadRegistryConfig))?;
    require_keys_eq!(info.key(), expected, OracleError::BadRegistryConfig);
    Ok(r.enforce)
}

/// Claims `nonce` for `loan` at `claim` (the PDA ["nonce", nonce]), creating it on first use (paid
/// by `payer`). Already claimed by this loan: no-op. By another loan: `NonceTaken`.
pub fn claim_nonce<'info>(claim: &AccountInfo<'info>, payer: &AccountInfo<'info>, nonce: &[u8; 32], loan: Pubkey) -> Result<()> {
    require!(claim.is_writable, OracleError::BadNonceClaim);
    if claim.owner == &crate::ID {
        let c = read_nonce_claim(claim, nonce)?;
        require_keys_eq!(c.loan, loan, OracleError::NonceTaken);
        return Ok(());
    }
    let (expected, bump) = Pubkey::find_program_address(&[NONCE_SEED, nonce], &crate::ID);
    require_keys_eq!(claim.key(), expected, OracleError::BadNonceClaim);
    let space = 8 + NonceClaim::INIT_SPACE;
    create_pda(claim, payer, &[NONCE_SEED, nonce, &[bump]], space)?;
    let c = NonceClaim { nonce: *nonce, loan, claimed_at: Clock::get()?.unix_timestamp, bump };
    c.try_serialize(&mut &mut claim.try_borrow_mut_data()?[..])
}

/// The proof's nonce must have been claimed by the loan it binds a device to.
pub fn require_nonce_claimed_by(claim: Option<&AccountInfo>, nonce: &[u8; 32], loan: Pubkey) -> Result<()> {
    let claim = claim.ok_or(error!(OracleError::BadNonceClaim))?;
    require!(claim.owner == &crate::ID, OracleError::BadNonceClaim);
    let c = read_nonce_claim(claim, nonce)?;
    require_keys_eq!(c.loan, loan, OracleError::NonceTaken);
    Ok(())
}

/// Deserialises a program-owned NonceClaim and checks it is the PDA for `nonce` (stored bump).
fn read_nonce_claim(claim: &AccountInfo, nonce: &[u8; 32]) -> Result<NonceClaim> {
    let c = NonceClaim::try_deserialize(&mut &claim.try_borrow_data()?[..]).map_err(|_| error!(OracleError::BadNonceClaim))?;
    require!(c.nonce == *nonce, OracleError::BadNonceClaim);
    let expected =
        Pubkey::create_program_address(&[NONCE_SEED, nonce, &[c.bump]], &crate::ID).map_err(|_| error!(OracleError::BadNonceClaim))?;
    require_keys_eq!(claim.key(), expected, OracleError::BadNonceClaim);
    Ok(c)
}

/// Who a proof wants to pledge the GPU to.
pub struct Pledge {
    pub chip_id: [u8; 32],
    pub loan: Pubkey,
    pub lender: Pubkey,
    pub now: i64,
    pub period: u32,
}

/// Binds `device` (the PDA for `p.chip_id`) to `p.loan`, creating it on first sight (paid by
/// `payer`). Bound to this loan already: no-op. Bound to another loan: `DevicePledgedElsewhere`.
pub fn bind_device<'info>(device: &AccountInfo<'info>, payer: &AccountInfo<'info>, p: &Pledge) -> Result<()> {
    require!(p.chip_id != [0u8; 32], OracleError::ZeroChipId);
    require!(device.is_writable, OracleError::BadDeviceAccount);

    let next = if device.owner == &crate::ID {
        let d = Device::try_deserialize(&mut &device.try_borrow_data()?[..]).map_err(|_| error!(OracleError::BadDeviceAccount))?;
        require!(d.chip_id == p.chip_id, OracleError::BadDeviceAccount);
        // Seen before: its stored bump is the canonical one, no search needed.
        let expected = Pubkey::create_program_address(&[DEVICE_SEED, &p.chip_id, &[d.bump]], &crate::ID)
            .map_err(|_| error!(OracleError::BadDeviceAccount))?;
        require_keys_eq!(device.key(), expected, OracleError::BadDeviceAccount);
        if d.loan == p.loan {
            return Ok(());
        }
        require!(d.loan == Pubkey::default(), OracleError::DevicePledgedElsewhere);
        Device { loan: p.loan, lender: p.lender, bound_at: p.now, bound_period: p.period, ..d }
    } else {
        let (expected, bump) = Pubkey::find_program_address(&[DEVICE_SEED, &p.chip_id], &crate::ID);
        require_keys_eq!(device.key(), expected, OracleError::BadDeviceAccount);
        create_pda(device, payer, &[DEVICE_SEED, &p.chip_id, &[bump]], 8 + Device::INIT_SPACE)?;
        Device {
            chip_id: p.chip_id,
            loan: p.loan,
            lender: p.lender,
            first_seen_at: p.now,
            first_seen_period: p.period,
            bound_at: p.now,
            bound_period: p.period,
            bump,
        }
    };
    next.try_serialize(&mut &mut device.try_borrow_mut_data()?[..])?;
    emit!(DeviceBound { chip_id: p.chip_id, loan: p.loan, lender: p.lender });
    Ok(())
}

/// Same as Anchor's `init` for the PDA signed by `seeds`: tolerates lamports sent to the address
/// beforehand, so nobody can block its creation by pre-funding it.
fn create_pda<'info>(account: &AccountInfo<'info>, payer: &AccountInfo<'info>, seeds: &[&[u8]], space: usize) -> Result<()> {
    let rent = Rent::get()?.minimum_balance(space);
    let signer = &[seeds];
    let sys = system_program::ID;
    if account.lamports() == 0 {
        let cpi = system_program::CreateAccount { from: payer.clone(), to: account.clone() };
        return system_program::create_account(CpiContext::new_with_signer(sys, cpi, signer), rent, space as u64, &crate::ID);
    }
    let shortfall = rent.saturating_sub(account.lamports());
    if shortfall > 0 {
        system_program::transfer(CpiContext::new(sys, system_program::Transfer { from: payer.clone(), to: account.clone() }), shortfall)?;
    }
    system_program::allocate(
        CpiContext::new_with_signer(sys, system_program::Allocate { account_to_allocate: account.clone() }, signer),
        space as u64,
    )?;
    system_program::assign(CpiContext::new_with_signer(sys, system_program::Assign { account_to_assign: account.clone() }, signer), &crate::ID)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_all_zero_chip_id_is_refused_before_any_account_is_touched() {
        let (key, owner) = (Pubkey::new_unique(), Pubkey::default());
        let (mut lamports, mut data) = (0u64, [0u8; 0]);
        let device = AccountInfo::new(&key, false, true, &mut lamports, &mut data, &owner, false);
        let p = Pledge { chip_id: [0u8; 32], loan: Pubkey::new_unique(), lender: Pubkey::new_unique(), now: 0, period: 0 };
        let err = bind_device(&device, &device, &p).unwrap_err();
        assert!(err.to_string().contains("ZeroChipId"), "{err}");
    }
}
