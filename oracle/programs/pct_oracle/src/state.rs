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

/// Proven revenue for one period of a loan, summed across revenue sources.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Default, Debug, PartialEq, Eq)]
pub struct PeriodRevenue {
    pub period: u32,
    pub revenue_micro: u64,
    /// GPU-hours sold, in millionths; 0 when no source in the period reported hours.
    pub gpu_hours_micro: u64,
    pub proofs: u8,
}

/// A GPU-backed loan whose covenant is checked against operator-proven revenue.
/// Lamports above rent are the facility's undrawn funds.
#[account]
#[derive(InitSpace)]
pub struct Loan {
    pub lender: Pubkey,
    pub borrower: Pubkey,
    /// keccak of the operator's account id as revealed (OPRF-hashed) in its revenue proofs.
    pub operator_key: [u8; 32],
    pub sku: u8,
    pub fleet_gpus: u16,
    pub period_s: u32,
    pub debt_service_micro: u64,
    pub min_coverage_bps: u16,
    pub drawn_lamports: u64,
    pub history: [PeriodRevenue; LOAN_HISTORY],
    pub updated_at: i64,
    pub bump: u8,
}

impl Loan {
    pub fn period_of(&self, unix_s: i64) -> u32 {
        (unix_s.max(0) / self.period_s as i64) as u32
    }

    /// Adds proven revenue to its period's slot, evicting the oldest period when full.
    pub fn record(&mut self, period: u32, revenue_micro: u64, gpu_hours_micro: u64) {
        let slot = match self.history.iter().position(|p| p.proofs > 0 && p.period == period) {
            Some(i) => i,
            None => {
                let i = self
                    .history
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, p)| if p.proofs == 0 { (0, 0) } else { (1, p.period) })
                    .map(|(i, _)| i)
                    .unwrap_or(0);
                self.history[i] = PeriodRevenue { period, ..Default::default() };
                i
            }
        };
        let p = &mut self.history[slot];
        p.revenue_micro = p.revenue_micro.saturating_add(revenue_micro);
        p.gpu_hours_micro = p.gpu_hours_micro.saturating_add(gpu_hours_micro);
        p.proofs = p.proofs.saturating_add(1);
    }

    pub fn latest(&self) -> Option<PeriodRevenue> {
        self.history.iter().filter(|p| p.proofs > 0).max_by_key(|p| p.period).copied()
    }

    /// Revenue over debt service, in basis points.
    pub fn coverage_bps(&self, p: &PeriodRevenue) -> u64 {
        ((p.revenue_micro as u128 * 10_000) / self.debt_service_micro as u128).min(u64::MAX as u128) as u64
    }

    /// Trailing coverage in basis points: revenue proven over the window ending at `latest`
    /// (capped at one quarter and at the loan's first proven period) divided by debt service for
    /// every period in that window. Periods without a proof count as zero revenue.
    pub fn trailing_coverage_bps(&self, latest: u32) -> u64 {
        let first = self.history.iter().filter(|p| p.proofs > 0).map(|p| p.period).min().unwrap_or(latest);
        let max_periods = (COVENANT_WINDOW_S.div_ceil(self.period_s)).clamp(1, LOAN_HISTORY as u32);
        let start = latest.saturating_sub(max_periods - 1).max(first);
        let periods = (latest - start + 1) as u128;
        let revenue: u128 = self
            .history
            .iter()
            .filter(|p| p.proofs > 0 && p.period >= start && p.period <= latest)
            .map(|p| p.revenue_micro as u128)
            .sum();
        ((revenue * 10_000) / (periods * self.debt_service_micro as u128)).min(u64::MAX as u128) as u64
    }

    /// Covenant: the latest proven period must be the current or previous one, and trailing
    /// revenue must cover debt service at min_coverage_bps.
    pub fn covenant(&self, now: i64) -> core::result::Result<u64, CovenantFailure> {
        let latest = self.latest().ok_or(CovenantFailure::NoRecentRevenue)?;
        if latest.period + 1 < self.period_of(now) {
            return Err(CovenantFailure::NoRecentRevenue);
        }
        let coverage = self.trailing_coverage_bps(latest.period);
        if coverage < self.min_coverage_bps as u64 {
            return Err(CovenantFailure::Breached(coverage));
        }
        Ok(coverage)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum CovenantFailure {
    NoRecentRevenue,
    Breached(u64),
}

#[cfg(test)]
mod loan_tests {
    use super::*;

    fn loan() -> Loan {
        Loan {
            lender: Pubkey::default(),
            borrower: Pubkey::default(),
            operator_key: [0; 32],
            sku: 0,
            fleet_gpus: 8,
            period_s: 604_800,
            debt_service_micro: 1_500_000_000,
            min_coverage_bps: 13_500,
            drawn_lamports: 0,
            history: [PeriodRevenue::default(); LOAN_HISTORY],
            updated_at: 0,
            bump: 0,
        }
    }

    #[test]
    fn sums_sources_within_a_period() {
        let mut l = loan();
        l.record(10, 2_580_480_000, 1_075_200_000);
        l.record(10, 400_000_000, 0);
        let p = l.latest().unwrap();
        assert_eq!((p.period, p.revenue_micro, p.gpu_hours_micro, p.proofs), (10, 2_980_480_000, 1_075_200_000, 2));
        assert_eq!(l.coverage_bps(&p), 19_869);
    }

    #[test]
    fn covenant_needs_recent_and_sufficient_revenue() {
        let mut l = loan();
        let week = 604_800i64;
        assert_eq!(l.covenant(10 * week), Err(CovenantFailure::NoRecentRevenue));
        l.record(10, 2_580_480_000, 0);
        assert_eq!(l.covenant(10 * week + 5), Ok(17_203));
        assert_eq!(l.covenant(11 * week + 5), Ok(17_203), "previous period still counts");
        assert_eq!(l.covenant(12 * week + 5), Err(CovenantFailure::NoRecentRevenue));
        l.record(12, 1_440_000_000, 0);
        // Trailing: (2580.48 + 0 + 1440) / (3 x 1500) = 0.89x; the unproven week 11 counts as zero.
        assert_eq!(l.covenant(12 * week + 5), Err(CovenantFailure::Breached(8_934)));
    }

    #[test]
    fn evicts_the_oldest_period() {
        let mut l = loan();
        for period in 0..(LOAN_HISTORY as u32 + 3) {
            l.record(period, 1, 0);
        }
        let mut periods: Vec<u32> = l.history.iter().map(|p| p.period).collect();
        periods.sort();
        assert_eq!(periods, (3..LOAN_HISTORY as u32 + 3).collect::<Vec<_>>());
    }
}
