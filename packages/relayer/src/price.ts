import type { BookState } from "@pct/oracle";

/**
 * Formats micro-USD as a Hyperliquid perp price: at most 5 significant figures and at most
 * (6 - szDecimals) decimals, trailing zeros trimmed.
 */
export function formatHlPrice(micro: bigint | number, szDecimals: number): string {
  const value = Number(micro) / 1e6;
  if (!(value > 0) || !Number.isFinite(value)) throw new Error(`price must be positive, got ${value}`);
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const sigDecimals = Math.max(0, 5 - (Math.floor(Math.log10(value)) + 1));
  const decimals = Math.min(maxDecimals, sigDecimals);
  const fixed = value.toFixed(decimals);
  return decimals > 0 ? fixed.replace(/\.?0+$/, "") : fixed;
}

/** Moves from `prev` toward `target` by at most `maxStepBps`, so a shock walks in instead of jumping. */
export function clampStep(prev: bigint | null, target: bigint, maxStepBps: number): bigint {
  if (prev === null || prev <= 0n) return target;
  const maxMove = (prev * BigInt(maxStepBps)) / 10_000n;
  if (target > prev + maxMove) return prev + maxMove;
  if (target < prev - maxMove) return prev - maxMove;
  return target;
}

export interface RelayPolicy {
  /** Book must have been cranked within this many seconds. */
  maxAgeS: number;
  maxStepBps: number;
}

export type Decision = { post: true; micro: bigint; target: bigint } | { post: false; reason: string };

/** Posts only a live, recently cranked index; otherwise holds the last price (HIP-3 keeps it). */
export function decide(book: BookState | null, nowS: number, prev: bigint | null, policy: RelayPolicy): Decision {
  if (!book) return { post: false, reason: "book not initialized" };
  if (book.status !== "live") return { post: false, reason: `index ${book.status} (needs 3+ providers)` };
  const age = nowS - Number(book.updatedAt);
  if (age > policy.maxAgeS) return { post: false, reason: `index stale: last crank ${age}s ago` };
  return { post: true, micro: clampStep(prev, book.valueMicro, policy.maxStepBps), target: book.valueMicro };
}
