use anchor_lang::prelude::*;

use crate::constants::*;
use crate::math;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Debug, PartialEq, Eq)]
pub struct IndexParams {
    pub max_staleness_s: i64,
    pub max_future_skew_s: i64,
    pub min_providers: u8,
    pub provider_cap_bps: u16,
    pub mad_k_milli: u32,
    pub mad_floor_bps: u16,
}

impl IndexParams {
    pub fn is_valid(&self) -> bool {
        self.max_staleness_s > 0
            && self.max_future_skew_s >= 0
            && self.min_providers >= 1
            && (1..=10_000).contains(&self.provider_cap_bps)
            && self.mad_k_milli >= 1_000
            && self.mad_floor_bps <= 10_000
    }

    pub fn to_math(self) -> math::Params {
        math::Params {
            max_staleness_s: self.max_staleness_s,
            max_future_skew_s: self.max_future_skew_s,
            min_providers: self.min_providers,
            provider_cap_bps: self.provider_cap_bps,
            mad_k_milli: self.mad_k_milli,
            mad_floor_bps: self.mad_floor_bps,
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    /// Ethereum addresses of Reclaim attestors whose signatures are accepted.
    #[max_len(MAX_ATTESTORS)]
    pub attestors: Vec<[u8; 20]>,
    pub params: IndexParams,
    pub bump: u8,
}

/// A registered provable price source. `params_hash` pins the claim's URL and match rules.
#[account]
#[derive(InitSpace)]
pub struct PriceSource {
    pub source_id: [u8; 32],
    pub params_hash: [u8; 32],
    pub provider_id: u16,
    pub sku: u8,
    pub kind: u8,
    pub gpu_count: u16,
    pub value_mode: u8,
    pub requires_nullifier: bool,
    pub active: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Default, Debug, PartialEq, Eq)]
pub struct Slot {
    pub provider_id: u16,
    pub price_micro: u64,
    pub observed_at: i64,
    pub weight: u32,
}

/// Ring buffer of recent observations for one (sku, kind), plus the last cranked value.
#[account]
#[derive(InitSpace)]
pub struct Book {
    pub sku: u8,
    pub kind: u8,
    pub next: u8,
    pub len: u8,
    pub slots: [Slot; BOOK_CAPACITY],
    pub value_micro: u64,
    /// 0 never cranked, 1 live, 2 frozen.
    pub status: u8,
    pub used: u8,
    pub rejected: u8,
    pub updated_at: i64,
    pub bump: u8,
}

impl Book {
    pub fn push(&mut self, slot: Slot) {
        self.slots[self.next as usize] = slot;
        self.next = ((self.next as usize + 1) % BOOK_CAPACITY) as u8;
        self.len = core::cmp::min(self.len as usize + 1, BOOK_CAPACITY) as u8;
    }

    pub fn points(&self) -> Vec<math::Point> {
        self.slots[..self.len as usize]
            .iter()
            .map(|s| math::Point { provider: s.provider_id, price: s.price_micro, observed_at: s.observed_at, weight: s.weight })
            .collect()
    }
}

/// Staging area for a claim too large for one transaction: provider | parameters | context.
#[account]
pub struct ClaimBuffer {
    pub authority: Pubkey,
    pub provider_len: u16,
    pub parameters_len: u16,
    pub context_len: u16,
    pub data: Vec<u8>,
}

impl ClaimBuffer {
    pub fn space(total: usize) -> usize {
        8 + 32 + 2 + 2 + 2 + 4 + total
    }

    pub fn parts(&self) -> Option<(&[u8], &[u8], &[u8])> {
        let (p, q, c) = (self.provider_len as usize, self.parameters_len as usize, self.context_len as usize);
        if p + q + c != self.data.len() {
            return None;
        }
        Some((&self.data[..p], &self.data[p..p + q], &self.data[p + q..]))
    }
}

/// Exists only to make a nullifier (or proof) single-use.
#[account]
#[derive(InitSpace)]
pub struct Receipt {
    pub source: Pubkey,
    pub observed_at: i64,
}
