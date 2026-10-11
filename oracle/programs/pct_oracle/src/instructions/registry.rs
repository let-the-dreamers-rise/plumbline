//! Cross-lender GPU device registry: one `Device` PDA per GPU (seeded by the chip id the covenant
//! proof commits to), recording the loan it is pledged to. While the zk config enforces it, a
//! covenant proof for a GPU already pledged to another loan (of any lender) is refused, so the
//! same card cannot back two loans. The bound loan's lender releases it when the loan is closed.

use anchor_lang::{prelude::*, system_program};

use crate::{constants::*, error::OracleError, instructions::zk::*, state::Config};

pub const DEVICE_SEED: &[u8] = b"device";

#[account]
#[derive(InitSpace)]
pub struct Device {
    /// sha256 of the GPU's per-chip id (journal word 0).
    pub chip_id: [u8; 32],
    /// Loan the GPU is pledged to; `Pubkey::default()` while free.
    pub loan: Pubkey,
    /// That loan's lender, the only key that can release the pledge.
    pub lender: Pubkey,
    pub first_seen_at: i64,
    pub first_seen_period: u32,
    pub bound_at: i64,
    pub bound_period: u32,
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
}

#[derive(Accounts)]
pub struct SetDeviceRegistry<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ OracleError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [ZK_CONFIG_SEED], bump = zk_config.bump)]
    pub zk_config: Account<'info, ZkConfig>,
}

pub fn handle_set_device_registry(ctx: Context<SetDeviceRegistry>, enforce: bool) -> Result<()> {
    ctx.accounts.zk_config.enforce_device_registry = enforce;
    Ok(())
}

#[derive(Accounts)]
pub struct ReleaseDevice<'info> {
    pub lender: Signer<'info>,
    #[account(mut, seeds = [DEVICE_SEED, device.chip_id.as_ref()], bump = device.bump, has_one = lender @ OracleError::NotLender)]
    pub device: Account<'info, Device>,
}

/// The bound loan's lender frees the GPU (loan repaid or closed) so it can be pledged again.
pub fn handle_release_device(ctx: Context<ReleaseDevice>) -> Result<()> {
    let d = &mut ctx.accounts.device;
    emit!(DeviceReleased { chip_id: d.chip_id, loan: d.loan, lender: d.lender });
    d.loan = Pubkey::default();
    d.lender = Pubkey::default();
    Ok(())
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
    let (expected, bump) = Pubkey::find_program_address(&[DEVICE_SEED, &p.chip_id], &crate::ID);
    require_keys_eq!(device.key(), expected, OracleError::BadDeviceAccount);
    require!(device.is_writable, OracleError::BadDeviceAccount);

    let next = if device.owner == &crate::ID {
        let d = Device::try_deserialize(&mut &device.try_borrow_data()?[..])?;
        if d.loan == p.loan {
            return Ok(());
        }
        require!(d.loan == Pubkey::default(), OracleError::DevicePledgedElsewhere);
        Device { loan: p.loan, lender: p.lender, bound_at: p.now, bound_period: p.period, ..d }
    } else {
        create_device(device, payer, &p.chip_id, bump)?;
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

/// Same as Anchor's `init`: tolerates lamports sent to the address beforehand, so nobody can
/// block a GPU's first pledge by pre-funding its PDA.
fn create_device<'info>(device: &AccountInfo<'info>, payer: &AccountInfo<'info>, chip_id: &[u8; 32], bump: u8) -> Result<()> {
    let space = 8 + Device::INIT_SPACE;
    let rent = Rent::get()?.minimum_balance(space);
    let seeds: &[&[u8]] = &[DEVICE_SEED, chip_id, &[bump]];
    let signer = &[seeds];
    let sys = system_program::ID;
    if device.lamports() == 0 {
        let cpi = system_program::CreateAccount { from: payer.clone(), to: device.clone() };
        return system_program::create_account(CpiContext::new_with_signer(sys, cpi, signer), rent, space as u64, &crate::ID);
    }
    let shortfall = rent.saturating_sub(device.lamports());
    if shortfall > 0 {
        system_program::transfer(CpiContext::new(sys, system_program::Transfer { from: payer.clone(), to: device.clone() }), shortfall)?;
    }
    system_program::allocate(
        CpiContext::new_with_signer(sys, system_program::Allocate { account_to_allocate: device.clone() }, signer),
        space as u64,
    )?;
    system_program::assign(CpiContext::new_with_signer(sys, system_program::Assign { account_to_assign: device.clone() }, signer), &crate::ID)
}
