import { ARBISCAN, COLLATERAL_NFT, ROUTER_V1, type Assumptions, type GpuModel } from "./constants.js";
import { originalPrincipal, outstandingPrincipal, type LoanRecord } from "./book.js";
import { describe, type Collateral, type CollateralComponent } from "./collateral.js";
import { aprOf, tokens, type LoanState } from "./decode.js";
import type { Enrichment } from "./enrich.js";
import {
  breakevenUtilization,
  coverageRatio,
  depreciatedValue,
  levelPayment,
  ltv,
  monthsElapsed,
  round,
  termMonths,
} from "./finance.js";
import type { ModelPrice } from "./prices.js";
import type { LoanView, RepaymentHealth, Sourced } from "./types.js";

export interface LoanInputs {
  readonly record: LoanRecord;
  /** First record of the loan's migration/refinance chain. */
  readonly root: LoanRecord;
  readonly state: LoanState | null;
  readonly stateSource: string;
  readonly collateral: readonly Collateral[];
  readonly enrichment: Enrichment | null;
  readonly prices: Readonly<Record<GpuModel, ModelPrice>>;
  readonly priceSource: string;
  readonly assumptions: Assumptions;
  readonly nowS: number;
}

const DAY = 86_400;
export const txUrl = (hash: string) => `${ARBISCAN}/tx/${hash}`;
const iso = (s: number | null) => (s === null ? null : new Date(s * 1000).toISOString());
const S = <T>(value: T, source: string): Sourced<T> => ({ value, source });
const r2 = (x: number | null, dp = 2) => (x === null || !Number.isFinite(x) ? null : round(x, dp));

/** GPU-weighted market price over the collateral's models; null if any model has no price. */
export function marketPrice(collateral: readonly Collateral[], prices: Readonly<Record<GpuModel, ModelPrice>>): number | null {
  // Non-GPU items (network, racks) carry no GPUs and no rent.
  const parts = collateral.flatMap((c) => c.components).filter((p) => p.gpus !== 0);
  if (parts.length === 0) return null;
  const priced = parts.map((p) => ({ gpus: p.gpus, price: p.model ? prices[p.model]?.medianUsdPerGpuHr ?? null : null }));
  if (priced.some((p) => p.gpus === null || p.price === null)) return null;
  const gpus = priced.reduce((s, p) => s + p.gpus!, 0);
  return gpus > 0 ? priced.reduce((s, p) => s + p.gpus! * p.price!, 0) / gpus : null;
}

/** Sums components per model (non-GPU items under "other") for the loan view. */
export function mergeComponents(parts: readonly CollateralComponent[]): readonly CollateralComponent[] {
  const keyOf = (p: CollateralComponent) => p.model ?? (p.gpus === 0 ? "other" : p.label);
  const keys = [...new Set(parts.map(keyOf))];
  return keys.map((k) => {
    const mine = parts.filter((p) => keyOf(p) === k);
    const gpus = mine.some((p) => p.gpus === null) ? null : mine.reduce((s, p) => s + p.gpus!, 0);
    return { model: mine[0]!.model, label: mine.length === 1 ? mine[0]!.label : k === "other" ? "non-GPU items" : k, units: mine.reduce((s, p) => s + p.units, 0), gpus };
  });
}

function health(state: LoanState | null, expected: number | null): RepaymentHealth {
  if (!state) return "unknown";
  if (state.status === "Breached") return "breached";
  if (state.status === "Liquidated" || state.status === "CollateralLiquidated") return "liquidated";
  if (expected === null) return "unknown";
  // One period of slack: the payment day may not have come round yet this month.
  return state.repaymentCount < expected - 1 ? "behind" : "current";
}

export function loanView(x: LoanInputs): LoanView {
  const { record: r, root, state, assumptions: a, nowS } = x;
  const terms = r.terms;
  const createdSrc = txUrl(r.createdTx);
  const principal = tokens(originalPrincipal(r));
  const outstanding = tokens(outstandingPrincipal(r));
  const nRepaid = r.repayments.length;
  const apr = terms ? aprOf(terms) : null;
  const termDays = terms?.termDays ?? null;
  const months = termDays ? termMonths(termDays) : null;
  const termStart = state && state.originationTimestamp > 0 ? state.originationTimestamp : r.createdAt;
  const maturity = termStart !== null && termDays !== null ? termStart + termDays * DAY : null;
  const gpus = x.collateral.length && x.collateral.every((c) => c.gpuCount !== null) ? x.collateral.reduce((s, c) => s + c.gpuCount!, 0) : null;
  const value = x.collateral.length && x.collateral.every((c) => c.valueUsd !== null) ? x.collateral.reduce((s, c) => s + c.valueUsd!, 0) : null;
  const lifeDays = x.collateral[0]?.usefulLifeDays ?? null;
  const metaSrc = x.collateral.map((c) => c.metadataUrl).join(" ") || "no collateral metadata";

  const payment = apr !== null && months !== null ? levelPayment(principal, apr, months) : null;
  const ds = payment !== null && gpus ? payment / gpus / a.hoursPerMonth : null;
  const market = marketPrice(x.collateral, x.prices);
  const breakeven = ds !== null ? breakevenUtilization(ds, market, a.opexPerGpuHr) : null;
  const coverage = ds !== null ? coverageRatio(market, a.utilization, ds, a.opexPerGpuHr) : null;
  const ageDays = root.createdAt !== null ? (nowS - root.createdAt) / DAY : null;
  const depValue = value !== null && ageDays !== null ? depreciatedValue(value, ageDays, a.depreciationYears * 365) : null;
  const expected = termStart !== null ? monthsElapsed(termStart, nowS) : null;
  const h = health(state, expected);
  const lastPaid = r.repayments.at(-1) ?? null;
  const dsSrc = `derived: level monthly payment on principal ${createdSrc} at its APR over ${months ?? "?"} months, / ${gpus ?? "?"} GPUs (${metaSrc}) / ${a.hoursPerMonth} h`;

  const flags = [
    ...(breakeven !== null && breakeven > a.breakevenFlag ? [`breakeven utilization ${Math.round(breakeven * 100)}% is above ${Math.round(a.breakevenFlag * 100)}%`] : []),
    ...(h === "behind" ? [`${state!.repaymentCount} repayments recorded, about ${expected} expected`] : []),
    ...(h === "breached" ? ["loan marked breached onchain"] : []),
    ...(maturity !== null && maturity < nowS ? ["past maturity"] : []),
    ...(depValue !== null && depValue > 0 && outstanding / depValue > 1 ? ["depreciation-adjusted LTV above 100%"] : []),
  ];

  return {
    id: terms?.collateralTokenIds.join("+") || r.hash.slice(0, 10),
    hash: r.hash,
    router: r.router,
    routerVersion: r.router === ROUTER_V1.toLowerCase() ? "v1" : "v2",
    status: state?.status ?? "Active (from events)",
    borrower: S(r.borrower, createdSrc),
    createdBy: r.createdBy,
    termsSource: r.termsSource,
    principalUsd: S(r2(principal), createdSrc),
    outstandingUsd: S(r2(outstanding), `derived: principal less principal and prepayment in ${nRepaid} LoanRepaid events on ${r.hash}`),
    aprPct: S(apr === null ? null : r2(apr * 100, 3), `${createdSrc} (principal-weighted lender tranche rate; placeholder tranches under 1,000 USDai left out)`),
    termDays: S(termDays, createdSrc),
    originatedAt: S(iso(root.createdAt), txUrl(root.createdTx)),
    currentTermsAt: S(iso(termStart), state ? x.stateSource : createdSrc),
    maturityAt: S(iso(maturity), `derived: current terms start + ${termDays ?? "?"} days`),
    daysToMaturity: S(maturity === null ? null : Math.round((maturity - nowS) / DAY), "derived: maturity - snapshot time"),
    repayments: {
      count: S(state?.repaymentCount ?? nRepaid, state ? x.stateSource : `${nRepaid} LoanRepaid events`),
      expectedApprox: S(expected, "derived: whole months since current terms start"),
      lastPaidAt: S(iso(lastPaid?.timestamp ?? null), lastPaid ? txUrl(lastPaid.tx) : "no LoanRepaid event"),
      health: h,
    },
    collateral: x.collateral.length
      ? {
          tokenIds: x.collateral.map((c) => c.tokenId),
          name: describe(x.collateral),
          models: mergeComponents(x.collateral.flatMap((c) => c.components)),
          units: S(x.collateral.reduce((s, c) => s + (c.units ?? 0), 0) || null, metaSrc),
          gpuCount: S(gpus, `${metaSrc} (units x assumed GPUs per unit)`),
          valueUsd: S(value, metaSrc),
          usefulLifeDays: S(lifeDays, metaSrc),
          metadataUrls: x.collateral.map((c) => c.metadataUrl),
        }
      : null,
    enrichment: x.enrichment
      ? {
          locationName: x.enrichment.locationName,
          offTakeCode: x.enrichment.offTakeCode,
          dealStatus: x.enrichment.dealStatus,
          appAprPct: x.enrichment.appAprPct === null ? null : r2(x.enrichment.appAprPct, 3),
          source: "https://app.usd.ai/loans",
        }
      : null,
    metrics: {
      monthlyPaymentUsd: S(r2(payment, 0), dsSrc.split(", /")[0]!),
      debtServicePerGpuHr: S(r2(ds, 4), dsSrc),
      marketPerGpuHr: S(r2(market, 4), x.priceSource),
      breakevenUtilization: S(r2(breakeven, 4), `derived: (debt service${a.opexPerGpuHr ? " + opex" : ""}) / market price`),
      coverageAtAssumedUtilization: S(r2(coverage, 3), `derived: market price x ${a.utilization} utilization${a.opexPerGpuHr ? " - opex" : ""} / debt service (gross of opex unless opex is set)`),
      rentDropToBreakeven: S(coverage !== null && coverage > 0 ? r2(1 - 1 / coverage, 4) : null, "derived: 1 - 1 / coverage"),
      statedLtv: S(r2(ltv(outstanding, value), 4), `derived: outstanding / collateral value (${metaSrc})`),
      depreciatedLtv: S(
        r2(ltv(outstanding, depValue), 4),
        `derived: outstanding / (collateral value straight-line depreciated over ${a.depreciationYears} years from ${txUrl(root.createdTx)})`,
      ),
    },
    flags,
    links: {
      createdTx: createdSrc,
      originTx: txUrl(root.createdTx),
      collateral: terms?.collateralTokenIds[0] ? `${ARBISCAN}/nft/${COLLATERAL_NFT}/${terms.collateralTokenIds[0]}` : null,
    },
  };
}
