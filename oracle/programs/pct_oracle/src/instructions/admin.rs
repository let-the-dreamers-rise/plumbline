use anchor_lang::prelude::*;

use crate::{constants::*, error::OracleError, state::*};

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_config(ctx: Context<InitializeConfig>, attestors: Vec<[u8; 20]>, params: IndexParams) -> Result<()> {
    require!(attestors.len() <= MAX_ATTESTORS, OracleError::TooManyAttestors);
    require!(params.is_valid(), OracleError::BadParams);
    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.attestors = attestors;
    config.params = params;
    config.bump = ctx.bumps.config;
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ OracleError::Unauthorized)]
    pub config: Account<'info, Config>,
}

pub fn handle_update_config(ctx: Context<UpdateConfig>, attestors: Vec<[u8; 20]>, params: IndexParams) -> Result<()> {
    require!(attestors.len() <= MAX_ATTESTORS, OracleError::TooManyAttestors);
    require!(params.is_valid(), OracleError::BadParams);
    ctx.accounts.config.attestors = attestors;
    ctx.accounts.config.params = params;
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct SourceArgs {
    pub source_id: [u8; 32],
    pub params_hash: [u8; 32],
    pub provider_id: u16,
    pub sku: u8,
    pub kind: u8,
    pub gpu_count: u16,
    pub value_mode: u8,
    pub requires_nullifier: bool,
}

#[derive(Accounts)]
#[instruction(args: SourceArgs)]
pub struct RegisterSource<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ OracleError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(init, payer = authority, space = 8 + PriceSource::INIT_SPACE, seeds = [SOURCE_SEED, args.source_id.as_ref()], bump)]
    pub source: Account<'info, PriceSource>,
    pub system_program: Program<'info, System>,
}

pub fn handle_register_source(ctx: Context<RegisterSource>, args: SourceArgs) -> Result<()> {
    require!(
        args.sku < SKU_COUNT
            && (args.kind == KIND_PAID || args.kind == KIND_LIST)
            && (args.value_mode == VALUE_MODE_RATE || args.value_mode == VALUE_MODE_AMOUNT_HOURS)
            && args.gpu_count >= 1,
        OracleError::BadSourceShape
    );
    // Paid sources must be single-use per invoice; list prices are public and need no nullifier.
    require!(args.kind != KIND_PAID || args.requires_nullifier, OracleError::BadSourceShape);
    ctx.accounts.source.set_inner(PriceSource {
        source_id: args.source_id,
        params_hash: args.params_hash,
        provider_id: args.provider_id,
        sku: args.sku,
        kind: args.kind,
        gpu_count: args.gpu_count,
        value_mode: args.value_mode,
        requires_nullifier: args.requires_nullifier,
        active: true,
        bump: ctx.bumps.source,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetSourceActive<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ OracleError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [SOURCE_SEED, source.source_id.as_ref()], bump = source.bump)]
    pub source: Account<'info, PriceSource>,
}

pub fn handle_set_source_active(ctx: Context<SetSourceActive>, active: bool) -> Result<()> {
    ctx.accounts.source.active = active;
    Ok(())
}

#[derive(Accounts)]
#[instruction(sku: u8, kind: u8)]
pub struct InitBook<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Book::INIT_SPACE, seeds = [BOOK_SEED, &[sku], &[kind]], bump)]
    pub book: Account<'info, Book>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_book(ctx: Context<InitBook>, sku: u8, kind: u8) -> Result<()> {
    require!(sku < SKU_COUNT && (kind == KIND_PAID || kind == KIND_LIST), OracleError::BadSourceShape);
    let book = &mut ctx.accounts.book;
    book.sku = sku;
    book.kind = kind;
    book.bump = ctx.bumps.book;
    Ok(())
}
