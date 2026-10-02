export const SKUS = ["H100", "H200", "B200"] as const;
export type Sku = (typeof SKUS)[number];

/** "paid" = proven transaction price; "list" = posted offer. Never mixed in one index. */
export type PriceKind = "paid" | "list";

/** One price point. Prices are integer micro-USD per GPU-hour to match the onchain program. */
export interface Observation {
  readonly sourceId: string;
  readonly provider: string;
  readonly sku: Sku;
  readonly kind: PriceKind;
  readonly microUsdPerGpuHour: number;
  readonly observedAtS: number;
  readonly weight: number;
  /** Hash of the redacted account/invoice id; the same invoice counts once. */
  readonly nullifier?: string;
}

export type RejectReason = "invalid" | "stale" | "future" | "duplicate" | "outlier";

export interface IndexParams {
  readonly nowS: number;
  readonly maxStalenessS: number;
  readonly maxFutureSkewS: number;
  readonly minSources: number;
  readonly providerCap: number;
  readonly madK: number;
  /** Floor on MAD as a fraction of the median, so identical quotes don't reject a 1-cent difference. */
  readonly madFloorFraction: number;
}

export interface IndexResult {
  readonly sku: Sku;
  readonly kind: PriceKind;
  readonly status: "live" | "frozen";
  readonly reason?: string;
  readonly valueMicroUsd: number | null;
  readonly used: readonly Observation[];
  readonly rejected: readonly { readonly obs: Observation; readonly reason: RejectReason }[];
}
