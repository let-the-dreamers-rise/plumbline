import {
  APP_LOANS_URL,
  ARBITRUM_RPC,
  COLLATERAL_NFT,
  GPUS_PER_UNIT,
  METADATA_BASE,
  MODELS,
  ROUTER_V1,
  ROUTERS,
  type Assumptions,
  type GpuModel,
} from "./constants.js";
import { buildBook, exclusionReason, originalPrincipal, phaseOf, rootOf, withCalldataTerms, type LoanRecord } from "./book.js";
import type { Collateral } from "./collateral.js";
import { tokens, type LoanState, type LoanTerms, type RouterEvent } from "./decode.js";
import { enrichmentFor, type Enrichment } from "./enrich.js";
import { round } from "./finance.js";
import { loanView, txUrl } from "./metrics.js";
import { PRICE_METHOD, type PriceArchive } from "./prices.js";
import type { BookSummary, ClosedLoanView, LoanView, Share, Snapshot } from "./types.js";

export interface SnapshotInputs {
  readonly events: readonly RouterEvent[];
  readonly calldataTerms: ReadonlyMap<string, LoanTerms | null>;
  readonly states: ReadonlyMap<string, LoanState>;
  readonly collateral: ReadonlyMap<string, Collateral>;
  readonly enrichment: readonly Enrichment[];
  readonly prices: PriceArchive | null;
  /** Where the price archive lives, e.g. data/gpu-prices/2026-10-12.json. */
  readonly priceArchivePath: string;
  readonly assumptions: Assumptions;
  readonly now: Date;
  readonly asOfBlock: number;
  /** Read failures from the CLI, carried into the snapshot. */
  readonly unavailable: readonly string[];
}

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);
const nn = (x: number | null): number => x ?? 0;

function shares(rows: readonly { key: string; usd: number; gpus?: number }[], total: number): readonly Share[] {
  const keys = [...new Set(rows.map((r) => r.key))];
  return keys
    .map((key) => {
      const mine = rows.filter((r) => r.key === key);
      const usd = sum(mine.map((r) => r.usd));
      const gpus = mine.some((r) => r.gpus !== undefined) ? sum(mine.map((r) => r.gpus ?? 0)) : undefined;
      return { key, outstandingUsd: round(usd, 2), share: total > 0 ? round(usd / total, 4) : 0, loans: mine.length, ...(gpus === undefined ? {} : { gpus }) };
    })
    .sort((a, b) => b.outstandingUsd - a.outstandingUsd);
}

/** Splits a loan's outstanding principal across its GPU models by GPU count. */
function modelRows(l: LoanView): readonly { key: string; usd: number; gpus: number }[] {
  const usd = nn(l.outstandingUsd.value);
  const parts = (l.collateral?.models ?? []).filter((p) => p.gpus !== 0);
  const gpus = sum(parts.map((p) => p.gpus ?? 0));
  if (!parts.length || gpus === 0) return [{ key: "unknown", usd, gpus: 0 }];
  return parts.map((p) => ({ key: p.model ?? p.label, usd: (usd * (p.gpus ?? 0)) / gpus, gpus: p.gpus ?? 0 }));
}

function weighted(loans: readonly LoanView[], pick: (l: LoanView) => number | null): number | null {
  const rows = loans.flatMap((l) => {
    const v = pick(l);
    const w = nn(l.outstandingUsd.value);
    return v === null || w <= 0 ? [] : [{ v, w }];
  });
  const w = sum(rows.map((r) => r.w));
  return w > 0 ? sum(rows.map((r) => r.v * r.w)) / w : null;
}

export function bookSummary(loans: readonly LoanView[], closed: BookSummary["closed"]): BookSummary {
  const outstanding = sum(loans.map((l) => nn(l.outstandingUsd.value)));
  const byBorrower = shares(loans.map((l) => ({ key: l.borrower.value ?? "unknown", usd: nn(l.outstandingUsd.value) })), outstanding);
  const located = loans.map((l) => ({ key: l.enrichment?.locationName ?? "unknown", usd: nn(l.outstandingUsd.value) }));
  const derived = "derived: sum over active loans (see each loan's sources)";
  const gpus = loans.every((l) => l.collateral?.gpuCount.value != null) ? sum(loans.map((l) => nn(l.collateral!.gpuCount.value))) : null;
  const value = sum(loans.map((l) => nn(l.collateral?.valueUsd.value ?? null)));
  const apr = weighted(loans, (l) => l.aprPct.value);
  const be = weighted(loans, (l) => l.metrics.breakevenUtilization.value);
  return {
    activeLoans: loans.length,
    principalUsd: { value: round(sum(loans.map((l) => nn(l.principalUsd.value))), 2), source: `${derived}; principal at origination or last refinance` },
    outstandingUsd: { value: round(outstanding, 2), source: derived },
    collateralValueUsd: { value: round(value, 2), source: `${derived}; stated values from ${METADATA_BASE}{id}` },
    gpus: { value: gpus, source: `${derived}; units x assumed GPUs per unit` },
    weightedAprPct: { value: apr === null ? null : round(apr, 3), source: "derived: outstanding-weighted lender APR" },
    weightedBreakevenUtilization: { value: be === null ? null : round(be, 4), source: "derived: outstanding-weighted breakeven utilization" },
    monthlyDebtServiceUsd: { value: round(sum(loans.map((l) => nn(l.metrics.monthlyPaymentUsd.value))), 0), source: "derived: sum of level monthly payments" },
    topBorrower: byBorrower[0] ?? null,
    byBorrower,
    byModel: shares(loans.flatMap(modelRows), outstanding),
    byLocation: shares(located, outstanding),
    flagged: loans.filter((l) => l.flags.length).map((l) => ({ id: l.id, flags: l.flags })),
    closed,
  };
}

function closedView(r: LoanRecord, note: string | null): ClosedLoanView {
  return {
    hash: r.hash,
    routerVersion: r.router === ROUTER_V1.toLowerCase() ? "v1" : "v2",
    phase: note ? "excluded" : phaseOf(r),
    borrower: r.borrower,
    principalUsd: { value: round(tokens(originalPrincipal(r)), 2), source: txUrl(r.createdTx) },
    successor: r.successor,
    note,
  };
}

export function buildSnapshot(x: SnapshotInputs): Snapshot {
  const nowS = Math.floor(x.now.getTime() / 1000);
  const book = withCalldataTerms(buildBook(x.events), x.calldataTerms);
  const active = book.filter((r) => phaseOf(r) === "active" && exclusionReason(r) === null);
  const excluded = book.filter((r) => exclusionReason(r) !== null);
  const models = x.prices?.models;
  const prices = (models ?? Object.fromEntries(MODELS.map((m) => [m, { medianUsdPerGpuHr: null, sources: [] }]))) as Record<GpuModel, PriceArchive["models"][GpuModel]>;
  const loans = active
    .map((r) =>
      loanView({
        record: r,
        root: rootOf(book, r),
        state: x.states.get(r.hash) ?? null,
        stateSource: `eth_call loanState(${r.hash}) on ${r.router} at block ${x.asOfBlock}`,
        collateral: (r.terms?.collateralTokenIds ?? []).flatMap((id) => (x.collateral.has(id) ? [x.collateral.get(id)!] : [])),
        enrichment: r.terms?.collateralTokenIds[0] ? enrichmentFor(x.enrichment, r.terms.collateralTokenIds[0]) : null,
        prices,
        priceSource: `${x.priceArchivePath} (median across sources)`,
        assumptions: x.assumptions,
        nowS,
      }),
    )
    .sort((a, b) => nn(b.outstandingUsd.value) - nn(a.outstandingUsd.value));
  const closedRecords = book.filter((r) => phaseOf(r) !== "active" || exclusionReason(r) !== null);
  const missingTerms = active.filter((r) => !r.terms).map((r) => `terms for loan ${r.hash} (no terms in its event and its origination calldata did not decode)`);
  const missingPrices = MODELS.filter((m) => prices[m]?.medianUsdPerGpuHr === null).map((m) => `public price for ${m}`);
  return {
    schema: "plumbline.monitor/v1",
    generatedAt: x.now.toISOString(),
    lender: "USD.AI",
    chain: "arbitrum-one",
    asOfBlock: x.asOfBlock,
    sources: {
      rpc: ARBITRUM_RPC,
      routers: [...ROUTERS],
      collateralNft: COLLATERAL_NFT,
      metadata: `${METADATA_BASE}{tokenId}`,
      app: APP_LOANS_URL,
      prices: x.priceArchivePath,
    },
    assumptions: {
      ...x.assumptions,
      amortization: "Level monthly payment that fully amortizes the principal at origination or last refinance over the term (months = round(days x 12 / 365)) at the lender APR, compounded monthly.",
      gpusPerUnit: Object.entries(GPUS_PER_UNIT).map(([k, v]) => `${k}: ${v}`).join(", "),
      depreciation: `Straight line to zero over ${x.assumptions.depreciationYears} years from the original origination; the metadata's own useful life is shown separately.`,
      priceMethod: PRICE_METHOD,
    },
    notes: [
      "Estimates from public data only: Arbitrum logs and view calls, USD.AI's public collateral metadata and app page, and public GPU rental prices.",
      "APR is the lender tranche rate in the loan terms. Fees (origination, repayment) are not in debt service; the app's all-in APR is shown when available.",
      "Coverage is gross of operating costs (power, hosting, staff) unless opexPerGpuHr is set, so it overstates what is left for debt service.",
      "Market price is today's public on-demand rental price; the borrowers' actual contracts (offtake) are not public.",
      "Not financial advice. Not affiliated with USD.AI.",
    ],
    prices,
    book: bookSummary(loans, {
      repaid: closedRecords.filter((r) => phaseOf(r) === "repaid").length,
      liquidated: closedRecords.filter((r) => phaseOf(r) === "liquidated").length,
      supersededByRefinanceOrMigration: closedRecords.filter((r) => phaseOf(r) === "superseded").length,
      excluded: excluded.length,
    }),
    loans,
    closedLoans: closedRecords.map((r) => closedView(r, exclusionReason(r))),
    unavailable: [...x.unavailable, ...missingTerms, ...missingPrices],
  };
}

/** Checks the fields the page and API rely on; returns the problems found (empty when valid). */
export function validateSnapshot(s: unknown): readonly string[] {
  const o = s as Partial<Snapshot> | null;
  if (!o || typeof o !== "object") return ["snapshot is not an object"];
  const problems = [
    ...(o.schema === "plumbline.monitor/v1" ? [] : ["schema is not plumbline.monitor/v1"]),
    ...(typeof o.generatedAt === "string" && !Number.isNaN(Date.parse(o.generatedAt)) ? [] : ["generatedAt is not an ISO date"]),
    ...(Array.isArray(o.loans) ? [] : ["loans is not an array"]),
    ...(o.book && typeof o.book.activeLoans === "number" ? [] : ["book.activeLoans missing"]),
    ...(o.assumptions && typeof o.assumptions.utilization === "number" ? [] : ["assumptions.utilization missing"]),
  ];
  const loanProblems = (Array.isArray(o.loans) ? o.loans : []).flatMap((l, i) => {
    const sourced = [l?.principalUsd, l?.outstandingUsd, l?.aprPct, l?.metrics?.debtServicePerGpuHr, l?.metrics?.breakevenUtilization];
    return sourced.every((v) => v && typeof v === "object" && "value" in v && typeof v.source === "string" && v.source.length > 0)
      ? []
      : [`loan ${i} has a number without a source`];
  });
  return [...problems, ...loanProblems];
}
