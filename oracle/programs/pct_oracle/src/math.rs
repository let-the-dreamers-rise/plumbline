//! Integer port of packages/core/src/aggregate.ts. Pure: no accounts, no syscalls.

/// Fixed-point scale for weights and provider shares.
pub const SCALE: u128 = 1_000_000_000_000;
/// MAD -> sigma for normal data, as 1.4826 * 10_000.
const MAD_TO_SIGMA_X10K: u128 = 14_826;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Point {
    pub provider: u16,
    pub price: u64,
    pub observed_at: i64,
    pub weight: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Params {
    pub max_staleness_s: i64,
    pub max_future_skew_s: i64,
    pub min_providers: u8,
    pub provider_cap_bps: u16,
    pub mad_k_milli: u32,
    pub mad_floor_bps: u16,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            max_staleness_s: 86_400,
            max_future_skew_s: 300,
            min_providers: 3,
            provider_cap_bps: 2_500,
            mad_k_milli: 3_000,
            mad_floor_bps: 50,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Live = 1,
    Frozen = 2,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub status: Status,
    /// Micro-USD per GPU-hour; 0 when frozen.
    pub value: u64,
    pub used: u8,
    pub rejected: u8,
}

/// Lower weighted median: first value whose cumulative weight reaches half the total.
pub fn weighted_median(entries: &mut [(u64, u128)]) -> Option<u64> {
    let total: u128 = entries.iter().map(|e| e.1).sum();
    if total == 0 {
        return None;
    }
    entries.sort_by_key(|e| e.0);
    let mut cumulative = 0u128;
    for (value, weight) in entries.iter() {
        cumulative += weight;
        if cumulative * 2 >= total {
            return Some(*value);
        }
    }
    entries.last().map(|e| e.0)
}

/// Provider shares (summing to ~SCALE) with nobody above the cap; equal shares if the cap is infeasible.
pub fn cap_shares(totals: &[(u16, u128)], cap_bps: u16) -> Vec<(u16, u128)> {
    let n = totals.len() as u128;
    if n == 0 {
        return Vec::new();
    }
    let cap = core::cmp::max(cap_bps as u128 * SCALE / 10_000, (SCALE + n - 1) / n);
    let mut capped = vec![false; totals.len()];
    loop {
        let n_capped = capped.iter().filter(|c| **c).count() as u128;
        let remaining = SCALE.saturating_sub(n_capped * cap);
        let free_total: u128 = totals.iter().zip(&capped).filter(|(_, c)| !**c).map(|(t, _)| t.1).sum();
        let shares: Vec<(u16, u128)> = totals
            .iter()
            .zip(&capped)
            .map(|(t, c)| match (*c, free_total) {
                (true, _) => (t.0, cap),
                (false, 0) => (t.0, 0),
                (false, ft) => (t.0, t.1 * remaining / ft),
            })
            .collect();
        let mut changed = false;
        for (i, s) in shares.iter().enumerate() {
            if !capped[i] && s.1 > cap {
                capped[i] = true;
                changed = true;
            }
        }
        if !changed {
            return shares;
        }
    }
}

fn provider_totals(points: &[Point]) -> Vec<(u16, u128)> {
    let mut totals: Vec<(u16, u128)> = Vec::new();
    for p in points {
        match totals.iter_mut().find(|t| t.0 == p.provider) {
            Some(t) => t.1 += p.weight as u128,
            None => totals.push((p.provider, p.weight as u128)),
        }
    }
    totals
}

fn distinct_providers(points: &[Point]) -> usize {
    provider_totals(points).len()
}

/// (price, effective weight) after the per-provider cap.
pub fn capped_weights(points: &[Point], cap_bps: u16) -> Vec<(u64, u128)> {
    let totals = provider_totals(points);
    let shares = cap_shares(&totals, cap_bps);
    points
        .iter()
        .map(|p| {
            let total = totals.iter().find(|t| t.0 == p.provider).map(|t| t.1).unwrap_or(1);
            let share = shares.iter().find(|s| s.0 == p.provider).map(|s| s.1).unwrap_or(0);
            (p.price, p.weight as u128 * share / total)
        })
        .collect()
}

fn frozen(used: usize, rejected: usize) -> Outcome {
    Outcome { status: Status::Frozen, value: 0, used: used as u8, rejected: rejected as u8 }
}

/// Same pipeline as computeIndex in TS. Dedupe happens at submit time via receipt PDAs.
pub fn compute(points: &[Point], params: &Params, now: i64) -> Outcome {
    let kept: Vec<Point> = points
        .iter()
        .copied()
        .filter(|p| p.price > 0 && p.weight > 0)
        .filter(|p| p.observed_at <= now + params.max_future_skew_s)
        .filter(|p| now - p.observed_at <= params.max_staleness_s)
        .collect();
    let mut rejected = points.len() - kept.len();
    if distinct_providers(&kept) < params.min_providers as usize {
        return frozen(kept.len(), rejected);
    }

    let mut weighted = capped_weights(&kept, params.provider_cap_bps);
    let center = match weighted_median(&mut weighted) {
        Some(c) => c,
        None => return frozen(kept.len(), rejected),
    };
    let mut deviations: Vec<(u64, u128)> = weighted.iter().map(|(v, w)| (v.abs_diff(center), *w)).collect();
    let mad = weighted_median(&mut deviations).unwrap_or(0) as u128;
    let floor = center as u128 * params.mad_floor_bps as u128 / 10_000;
    let limit = core::cmp::max(mad, floor) * params.mad_k_milli as u128 * MAD_TO_SIGMA_X10K / 10_000_000;

    let inliers: Vec<Point> = kept.iter().copied().filter(|p| (p.price.abs_diff(center) as u128) <= limit).collect();
    rejected += kept.len() - inliers.len();
    if distinct_providers(&inliers) < params.min_providers as usize {
        return frozen(inliers.len(), rejected);
    }
    let mut final_weights = capped_weights(&inliers, params.provider_cap_bps);
    match weighted_median(&mut final_weights) {
        Some(value) => Outcome { status: Status::Live, value, used: inliers.len() as u8, rejected: rejected as u8 },
        None => frozen(inliers.len(), rejected),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_790_000_000;

    fn pt(provider: u16, price: u64) -> Point {
        Point { provider, price, observed_at: NOW - 60, weight: 1 }
    }

    fn base() -> Vec<Point> {
        vec![pt(1, 2_490_000), pt(2, 2_690_000), pt(3, 2_100_000), pt(4, 2_800_000)]
    }

    #[test]
    fn live_weighted_median_matches_ts() {
        let o = compute(&base(), &Params::default(), NOW);
        assert_eq!(o.status, Status::Live);
        assert_eq!(o.value, 2_490_000);
        assert_eq!(o.used, 4);
    }

    #[test]
    fn freezes_below_three_providers() {
        let o = compute(&base()[..2], &Params::default(), NOW);
        assert_eq!(o.status, Status::Frozen);
        assert_eq!(o.value, 0);
    }

    #[test]
    fn many_points_from_two_providers_stay_frozen() {
        let pts: Vec<Point> = (0..6).map(|i| pt(1 + (i % 2) as u16, 2_400_000 + i)).collect();
        assert_eq!(compute(&pts, &Params::default(), NOW).status, Status::Frozen);
    }

    #[test]
    fn drops_stale_and_future_points() {
        let mut pts = base();
        pts.push(Point { observed_at: NOW - 100_000, ..pt(9, 9_000_000) });
        pts.push(Point { observed_at: NOW + 3_600, ..pt(10, 2_500_000) });
        let o = compute(&pts, &Params::default(), NOW);
        assert_eq!(o.value, 2_490_000);
        assert_eq!(o.rejected, 2);
    }

    #[test]
    fn rejects_mad_outlier() {
        let mut pts = base();
        pts.push(pt(66, 40_000_000));
        let o = compute(&pts, &Params::default(), NOW);
        assert_eq!(o.value, 2_490_000);
        assert_eq!(o.rejected, 1);
    }

    #[test]
    fn provider_flood_is_capped() {
        let mut pts = base();
        pts.extend((0..20).map(|_| pt(1, 2_200_000)));
        let o = compute(&pts, &Params::default(), NOW);
        assert_ne!(o.value, 2_200_000);
    }

    #[test]
    fn rejects_zero_price_and_weight() {
        let mut pts = base();
        pts.push(pt(7, 0));
        pts.push(Point { weight: 0, ..pt(8, 2_500_000) });
        assert_eq!(compute(&pts, &Params::default(), NOW).rejected, 2);
    }

    #[test]
    fn cap_shares_redistributes() {
        let shares = cap_shares(&[(1, 10), (2, 1), (3, 1), (4, 1), (5, 1)], 2_500);
        assert_eq!(shares[0].1, SCALE / 4);
        for s in &shares[1..] {
            assert_eq!(s.1, 187_500_000_000);
        }
    }

    #[test]
    fn cap_shares_infeasible_goes_equal() {
        let shares = cap_shares(&[(1, 10), (2, 1), (3, 1)], 2_500);
        for s in &shares {
            assert!(s.1.abs_diff(SCALE / 3) <= 1);
        }
        assert!(cap_shares(&[], 2_500).is_empty());
    }

    #[test]
    fn weighted_median_edges() {
        assert_eq!(weighted_median(&mut [(2, 1), (8, 1)]), Some(2));
        assert_eq!(weighted_median(&mut [(1, 1), (9, 5), (4, 1)]), Some(9));
        assert_eq!(weighted_median(&mut [(1, 0)]), None);
    }
}
