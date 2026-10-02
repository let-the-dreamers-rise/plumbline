use anchor_lang::prelude::*;

use crate::{constants::*, error::OracleError, state::ClaimBuffer};

#[derive(Accounts)]
#[instruction(provider_len: u16, parameters_len: u16, context_len: u16)]
pub struct OpenBuffer<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = ClaimBuffer::space(provider_len as usize + parameters_len as usize + context_len as usize),
        seeds = [BUFFER_SEED, authority.key().as_ref()],
        bump
    )]
    pub buffer: Account<'info, ClaimBuffer>,
    pub system_program: Program<'info, System>,
}

pub fn handle_open_buffer(ctx: Context<OpenBuffer>, provider_len: u16, parameters_len: u16, context_len: u16) -> Result<()> {
    let total = provider_len as usize + parameters_len as usize + context_len as usize;
    require!(total > 0 && total <= MAX_CLAIM_BYTES, OracleError::BadBuffer);
    let buffer = &mut ctx.accounts.buffer;
    buffer.authority = ctx.accounts.authority.key();
    buffer.provider_len = provider_len;
    buffer.parameters_len = parameters_len;
    buffer.context_len = context_len;
    buffer.data = vec![0u8; total];
    Ok(())
}

#[derive(Accounts)]
pub struct WriteBuffer<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [BUFFER_SEED, authority.key().as_ref()], bump, has_one = authority)]
    pub buffer: Account<'info, ClaimBuffer>,
}

pub fn handle_write_buffer(ctx: Context<WriteBuffer>, offset: u16, bytes: Vec<u8>) -> Result<()> {
    let data = &mut ctx.accounts.buffer.data;
    let start = offset as usize;
    let end = start.checked_add(bytes.len()).ok_or(OracleError::BadBuffer)?;
    require!(end <= data.len(), OracleError::BadBuffer);
    data[start..end].copy_from_slice(&bytes);
    Ok(())
}

#[derive(Accounts)]
pub struct CloseBuffer<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [BUFFER_SEED, authority.key().as_ref()], bump, has_one = authority, close = authority)]
    pub buffer: Account<'info, ClaimBuffer>,
}

pub fn handle_close_buffer(_ctx: Context<CloseBuffer>) -> Result<()> {
    Ok(())
}
