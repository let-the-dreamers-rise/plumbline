import type { PriceKind, Sku } from "@pct/core";

/** A regex the attestor checks against the response. Named groups become public extracted values. */
export interface MatchRule {
  readonly regex: string;
}

/**
 * Describes one provable price source. Everything here is public: the verifier uses the
 * same spec to check that a proof really came from this URL and these match rules.
 */
export interface SourceSpec {
  readonly id: string;
  readonly provider: string;
  readonly kind: PriceKind;
  readonly sku: Sku;
  /** GPUs per billed unit (e.g. 8 for an 8x H100 VM). */
  readonly gpuCount: number;
  /** Proof URL must start with this. */
  readonly urlPrefix: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Each rule must match; together they must expose either `rate`, or `amount` and `hours`. */
  readonly matches: readonly MatchRule[];
  /** Optional rule whose `account` group is OPRF-hashed into a nullifier instead of revealed. */
  readonly nullifierRule?: MatchRule;
}

const AZURE_FILTER = [
  "armSkuName eq 'Standard_ND96isr_H100_v5'",
  "armRegionName eq 'eastus'",
  "priceType eq 'Consumption'",
  "meterName eq 'ND96isrH100v5'",
  "productName eq 'Virtual Machines NDsr H100 v5 Series'",
].join(" and ");

/** Azure retail list price for an 8x H100 Linux VM in East US. Public, no auth: the Day 1 smoke test. */
export const AZURE_H100_LIST: SourceSpec = {
  id: "azure-list-h100-eastus",
  provider: "azure",
  kind: "list",
  sku: "H100",
  gpuCount: 8,
  urlPrefix: "https://prices.azure.com/api/retail/prices",
  url: `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(AZURE_FILTER)}`,
  headers: { accept: "application/json" },
  matches: [{ regex: '"retailPrice":(?<rate>[0-9]+(?:\\.[0-9]+)?),"unitPrice"' }],
};

export interface InvoiceSpecConfig {
  readonly id: string;
  readonly provider: string;
  readonly sku: Sku;
  readonly gpuCount: number;
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly matches: readonly MatchRule[];
  readonly nullifierRule?: MatchRule;
}

const NAMED_GROUP = /\(\?<([a-zA-Z]+)>/g;

export function groupNames(rules: readonly MatchRule[]): Set<string> {
  return new Set(rules.flatMap((r) => [...r.regex.matchAll(NAMED_GROUP)].map((m) => m[1])));
}

/** Validates a user-written invoice config (from a JSON file) into a paid-price SourceSpec. */
export function invoiceSpecFromConfig(raw: unknown): SourceSpec {
  if (typeof raw !== "object" || raw === null) throw new Error("invoice config must be an object");
  const c = raw as Partial<InvoiceSpecConfig>;
  const url = typeof c.url === "string" ? new URL(c.url) : null;
  if (!url || url.protocol !== "https:") throw new Error("invoice config needs an https url");
  if (!c.id || !c.provider) throw new Error("invoice config needs id and provider");
  if (c.sku !== "H100" && c.sku !== "H200" && c.sku !== "B200") throw new Error("sku must be H100, H200 or B200");
  if (!Number.isInteger(c.gpuCount) || (c.gpuCount ?? 0) < 1) throw new Error("gpuCount must be a positive integer");
  if (!Array.isArray(c.matches) || c.matches.length === 0) throw new Error("invoice config needs matches");
  c.matches.forEach((m) => new RegExp(m.regex));
  const groups = groupNames(c.matches);
  if (!groups.has("rate") && !(groups.has("amount") && groups.has("hours"))) {
    throw new Error("matches must capture (?<rate>) or both (?<amount>) and (?<hours>)");
  }
  if (c.nullifierRule && !groupNames([c.nullifierRule]).has("account")) {
    throw new Error("nullifierRule must capture (?<account>)");
  }
  return {
    id: c.id,
    provider: c.provider,
    kind: "paid",
    sku: c.sku,
    gpuCount: c.gpuCount!,
    urlPrefix: `${url.origin}${url.pathname}`,
    url: url.toString(),
    headers: c.headers,
    matches: c.matches,
    nullifierRule: c.nullifierRule,
  };
}
