use anchor_lang::prelude::*;

use crate::{constants::*, math, state::*};

#[derive(Accounts)]
pub struct CrankIndex<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [BOOK_SEED, &[book.sku], &[book.kind]], bump = book.bump)]
    pub book: Account<'info, Book>,
}

#[event]
pub struct IndexUpdated {
    pub sku: u8,
    pub kind: u8,
    pub status: u8,
    pub value_micro: u64,
    pub used: u8,
    pub rejected: u8,
    pub updated_at: i64,
}

/// Permissionless: anyone can recompute the index from the book's observations.
pub fn handle_crank_index(ctx: Context<CrankIndex>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let book = &mut ctx.accounts.book;
    let outcome = math::compute(&book.points(), &ctx.accounts.config.params.to_math(), now);
    book.status = outcome.status as u8;
    book.value_micro = outcome.value;
    book.used = outcome.used;
    book.rejected = outcome.rejected;
    book.updated_at = now;
    emit!(IndexUpdated {
        sku: book.sku,
        kind: book.kind,
        status: book.status,
        value_micro: book.value_micro,
        used: book.used,
        rejected: book.rejected,
        updated_at: now,
    });
    Ok(())
}
