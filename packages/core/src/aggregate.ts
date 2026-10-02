import type { IndexParams, IndexResult, Observation, PriceKind, RejectReason, Sku } from "./types.js";

export const DEFAULT_PARAMS: Omit<IndexParams, "nowS"> = {
  maxStalenessS: 86_400,
  maxFutureSkewS: 300,
  minSources: 3,
  providerCap: 0.25,
  madK: 3,
  madFloorFraction: 0.005,
};

/** Scale factor turning MAD into a standard-deviation estimate for normal data. */
const MAD_TO_SIGMA = 1.4826;

interface Weighted {
  readonly value: number;
  readonly weight: number;
}

type Rejection = { readonly obs: Observation; readonly reason: RejectReason };

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of empty set");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Lower weighted median: the first value whose cumulative weight reaches half the total. */
export function weightedMedian(entries: readonly Weighted[]): number {
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  if (!(total > 0)) throw new Error("weighted median needs positive total weight");
  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const half = total / 2;
  let cumulative = 0;
  for (const e of sorted) {
    cumulative += e.weight;
    if (cumulative >= half - 1e-12) return e.value;
  }
  return sorted[sorted.length - 1].value;
}

/**
 * Turns raw per-provider weight totals into shares that sum to 1 with no provider above `cap`.
 * If the cap is infeasible (fewer than 1/cap providers) every provider gets an equal share.
 */
export function capProviderShares(totals: ReadonlyMap<string, number>, cap: number): Map<string, number> {
  const providers = [...totals.keys()];
  const effectiveCap = Math.max(cap, 1 / providers.length);
  const capped = new Set<string>();
  let shares = new Map<string, number>();
  for (;;) {
    const free = providers.filter((p) => !capped.has(p));
    const freeTotal = free.reduce((sum, p) => sum + totals.get(p)!, 0);
    const remaining = 1 - capped.size * effectiveCap;
    shares = new Map(
      providers.map((p) => [p, capped.has(p) ? effectiveCap : (totals.get(p)! / freeTotal) * remaining]),
    );
    const over = free.filter((p) => shares.get(p)! > effectiveCap + 1e-12);
    if (over.length === 0) return shares;
    over.forEach((p) => capped.add(p));
  }
}

function isValid(o: Observation): boolean {
  return (
    Number.isSafeInteger(o.microUsdPerGpuHour) &&
    o.microUsdPerGpuHour > 0 &&
    Number.isFinite(o.weight) &&
    o.weight > 0 &&
    Number.isFinite(o.observedAtS)
  );
}

/** Validity and freshness. Returns kept observations plus rejections. */
function screen(candidates: readonly Observation[], p: IndexParams): [Observation[], Rejection[]] {
  const kept: Observation[] = [];
  const rejected: Rejection[] = [];
  for (const o of candidates) {
    if (!isValid(o)) rejected.push({ obs: o, reason: "invalid" });
    else if (o.observedAtS > p.nowS + p.maxFutureSkewS) rejected.push({ obs: o, reason: "future" });
    else if (p.nowS - o.observedAtS > p.maxStalenessS) rejected.push({ obs: o, reason: "stale" });
    else kept.push(o);
  }
  return [kept, rejected];
}

/** Same nullifier counts once; the newest observation wins. */
function dedupe(candidates: readonly Observation[]): [Observation[], Rejection[]] {
  const newest = new Map<string, Observation>();
  for (const o of candidates) {
    if (o.nullifier === undefined) continue;
    const prev = newest.get(o.nullifier);
    if (!prev || o.observedAtS > prev.observedAtS) newest.set(o.nullifier, o);
  }
  const kept = candidates.filter((o) => o.nullifier === undefined || newest.get(o.nullifier) === o);
  const rejected = candidates
    .filter((o) => o.nullifier !== undefined && newest.get(o.nullifier) !== o)
    .map((obs) => ({ obs, reason: "duplicate" as const }));
  return [kept, rejected];
}

/** Per-observation effective weights after the per-provider cap. */
function cappedWeights(candidates: readonly Observation[], cap: number): Weighted[] {
  const totals = new Map<string, number>();
  candidates.forEach((o) => totals.set(o.provider, (totals.get(o.provider) ?? 0) + o.weight));
  const shares = capProviderShares(totals, cap);
  return candidates.map((o) => ({
    value: o.microUsdPerGpuHour,
    weight: (o.weight / totals.get(o.provider)!) * shares.get(o.provider)!,
  }));
}

/** Rejects points further than k * sigma (from capped weighted MAD) from the capped weighted median. */
function rejectOutliers(candidates: readonly Observation[], p: IndexParams): [Observation[], Rejection[]] {
  const weighted = cappedWeights(candidates, p.providerCap);
  const center = weightedMedian(weighted);
  const mad = weightedMedian(weighted.map((w) => ({ value: Math.abs(w.value - center), weight: w.weight })));
  const limit = p.madK * MAD_TO_SIGMA * Math.max(mad, center * p.madFloorFraction);
  const kept = candidates.filter((o) => Math.abs(o.microUsdPerGpuHour - center) <= limit);
  const rejected = candidates
    .filter((o) => Math.abs(o.microUsdPerGpuHour - center) > limit)
    .map((obs) => ({ obs, reason: "outlier" as const }));
  return [kept, rejected];
}

/** Liveness counts independent providers, so one provider's many invoices can't keep the index live. */
function distinctProviders(candidates: readonly Observation[]): number {
  return new Set(candidates.map((o) => o.provider)).size;
}

function frozen(sku: Sku, kind: PriceKind, reason: string, used: Observation[], rejected: Rejection[]): IndexResult {
  return { sku, kind, status: "frozen", reason, valueMicroUsd: null, used, rejected };
}

/**
 * Reference implementation of the index the Solana program computes:
 * filter by sku/kind, drop invalid/stale/future, dedupe nullifiers, reject MAD outliers,
 * then take the provider-capped weighted median. Freezes below `minSources` live sources.
 */
export function computeIndex(
  observations: readonly Observation[],
  sku: Sku,
  kind: PriceKind,
  params: IndexParams,
): IndexResult {
  const relevant = observations.filter((o) => o.sku === sku && o.kind === kind);
  const [fresh, screenedOut] = screen(relevant, params);
  const [unique, duplicates] = dedupe(fresh);
  const rejectedSoFar = [...screenedOut, ...duplicates];
  const needed = `needs ${params.minSources} live providers (sources)`;
  if (distinctProviders(unique) < params.minSources) return frozen(sku, kind, needed, unique, rejectedSoFar);

  const [inliers, outliers] = rejectOutliers(unique, params);
  const rejected = [...rejectedSoFar, ...outliers];
  if (distinctProviders(inliers) < params.minSources) return frozen(sku, kind, needed, inliers, rejected);

  const value = Math.round(weightedMedian(cappedWeights(inliers, params.providerCap)));
  return { sku, kind, status: "live", valueMicroUsd: value, used: inliers, rejected };
}
