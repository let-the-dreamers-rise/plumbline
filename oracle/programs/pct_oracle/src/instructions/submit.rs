use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::OracleError,
    reclaim,
    state::*,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ClaimSig {
    /// Claim owner as a lowercase 0x address (part of the signed message).
    pub owner: String,
    pub timestamp_s: u32,
    pub epoch: u32,
    pub signature: [u8; 65],
}

#[derive(Accounts)]
#[instruction(sig: ClaimSig, receipt_key: [u8; 32])]
pub struct SubmitObservation<'info> {
    #[account(mut)]
    pub submitter: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [SOURCE_SEED, source.source_id.as_ref()], bump = source.bump)]
    pub source: Account<'info, PriceSource>,
    #[account(
        mut,
        seeds = [BOOK_SEED, &[source.sku], &[source.kind]],
        bump = book.bump,
        constraint = book.sku == source.sku && book.kind == source.kind @ OracleError::BookMismatch
    )]
    pub book: Account<'info, Book>,
    #[account(
        mut,
        seeds = [BUFFER_SEED, submitter.key().as_ref()],
        bump,
        constraint = buffer.authority == submitter.key() @ OracleError::BadBuffer,
        close = submitter
    )]
    pub buffer: Account<'info, ClaimBuffer>,
    #[account(
        init,
        payer = submitter,
        space = 8 + Receipt::INIT_SPACE,
        seeds = [RECEIPT_SEED, source.key().as_ref(), receipt_key.as_ref()],
        bump
    )]
    pub receipt: Account<'info, Receipt>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct ObservationAccepted {
    pub source: Pubkey,
    pub provider_id: u16,
    pub sku: u8,
    pub kind: u8,
    pub price_micro: u64,
    pub observed_at: i64,
    pub identifier: [u8; 32],
}

/// The single-use key: the hashed account nullifier for paid sources, else the claim itself.
pub fn expected_receipt_key(source: &PriceSource, identifier: &[u8; 32], context: &[u8], timestamp_s: u32) -> Result<[u8; 32]> {
    if source.requires_nullifier {
        let account = reclaim::extract_param(context, "account").map_err(OracleError::from)?;
        Ok(reclaim::keccak(account))
    } else {
        let mut bytes = [0u8; 36];
        bytes[..32].copy_from_slice(identifier);
        bytes[32..].copy_from_slice(&timestamp_s.to_le_bytes());
        Ok(reclaim::keccak(&bytes))
    }
}

pub fn handle_submit_observation(ctx: Context<SubmitObservation>, sig: ClaimSig, receipt_key: [u8; 32]) -> Result<()> {
    let source = &ctx.accounts.source;
    let params = ctx.accounts.config.params;
    require!(source.active, OracleError::SourceInactive);

    let (provider, parameters, context) = ctx.accounts.buffer.parts().ok_or(OracleError::BadBuffer)?;
    require!(reclaim::keccak(parameters) == source.params_hash, OracleError::ParamsMismatch);

    let identifier = reclaim::claim_identifier(provider, parameters, context);
    let message = reclaim::sign_message(&identifier, &sig.owner, sig.timestamp_s, sig.epoch).map_err(OracleError::from)?;
    let signer = reclaim::recover_eth_signer(&reclaim::eth_message_hash(&message), &sig.signature).map_err(OracleError::from)?;
    require!(ctx.accounts.config.attestors.contains(&signer), OracleError::UnknownAttestor);

    let now = Clock::get()?.unix_timestamp;
    let observed_at = sig.timestamp_s as i64;
    require!(observed_at <= now + params.max_future_skew_s, OracleError::FutureClaim);
    require!(now - observed_at <= params.max_staleness_s, OracleError::StaleClaim);
    require!(
        receipt_key == expected_receipt_key(source, &identifier, context, sig.timestamp_s)?,
        OracleError::ReceiptMismatch
    );

    let amount_mode = source.value_mode == VALUE_MODE_AMOUNT_HOURS;
    let price = reclaim::price_per_gpu_hour(context, amount_mode, source.gpu_count).map_err(OracleError::from)?;
    require!(price > 0, OracleError::BadNumber);

    ctx.accounts.book.push(Slot { provider_id: source.provider_id, price_micro: price, observed_at, weight: 1 });
    ctx.accounts.receipt.set_inner(Receipt { source: source.key(), observed_at });
    emit!(ObservationAccepted {
        source: source.key(),
        provider_id: source.provider_id,
        sku: source.sku,
        kind: source.kind,
        price_micro: price,
        observed_at,
        identifier,
    });
    Ok(())
}
