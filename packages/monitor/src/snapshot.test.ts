import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCollateral } from "./collateral.js";
import { DEFAULT_ASSUMPTIONS } from "./constants.js";
import { decodeLoanState, decodeLog, type RawLog, type RouterEvent } from "./decode.js";
import { parseAppLoans } from "./enrich.js";
import { fixture, fixtureJson } from "./fixtures.js";
import { buildArchive, parseAkash, parseRunpod, parseVast } from "./prices.js";
import { buildSnapshot, validateSnapshot, type SnapshotInputs } from "./snapshot.js";

const events = fixtureJson<RawLog[]>("router-logs.json").flatMap((l) => {
  const e = decodeLog(l);
  return e ? [e] : [];
});
const state = fixtureJson<{ hash: string; result: string }>("loanstate-1008.json");
const NOW = new Date("2026-10-12T18:00:00Z");
const originTs = decodeLoanState(state.result).originationTimestamp;
// The recorded logs carry blockTimestamp 0x0, as the public RPC returns for older blocks; give 1008's origination a time.
const timed = events.map((e): RouterEvent => (e.kind === "originated" && e.terms?.collateralTokenIds[0] === "1008" ? { ...e, timestamp: originTs } : e));
const prices = buildArchive(
  { "vast.ai": parseVast(fixtureJson("vast.json")), runpod: parseRunpod(fixtureJson("runpod.json")), akash: parseAkash(fixtureJson("akash.json")) },
  NOW,
  [],
);

const inputs: SnapshotInputs = {
  events: timed,
  calldataTerms: new Map(),
  states: new Map([[state.hash, decodeLoanState(state.result)]]),
  collateral: new Map([["1008", parseCollateral("1008", "https://metadata.usd.ai/v1/1008", fixtureJson("metadata-1008.json"))]]),
  enrichment: parseAppLoans(fixture("app-loans-excerpt.html")),
  prices,
  priceArchivePath: "data/gpu-prices/2026-10-12.json",
  assumptions: DEFAULT_ASSUMPTIONS,
  now: NOW,
  asOfBlock: 514_000_000,
  unavailable: [],
};

describe("buildSnapshot from recorded fixtures", () => {
  const snap = buildSnapshot(inputs);
  const l1008 = snap.loans.find((l) => l.id === "1008")!;

  it("has the documented shape and passes validation", () => {
    expect(validateSnapshot(snap)).toEqual([]);
    expect(snap.schema).toBe("plumbline.monitor/v1");
    expect(snap.assumptions.utilization).toBe(0.7);
    expect(snap.assumptions.depreciationYears).toBe(5);
    expect(snap.notes.join(" ")).toMatch(/Not financial advice\. Not affiliated with USD\.AI\./);
    expect(Object.keys(snap.prices)).toEqual(["H100", "H200", "B200", "B300", "GB200", "RTX PRO 6000"]);
  });

  it("reproduces loan 1008: 54.4M at 8.5% over 1095 days on 1,040 B300 GPUs", () => {
    expect(l1008.principalUsd.value).toBeCloseTo(54_404_473, -1);
    expect(l1008.aprPct.value).toBeCloseTo(8.5, 2);
    expect(l1008.termDays.value).toBe(1095);
    expect(l1008.collateral?.gpuCount.value).toBe(1040);
    expect(l1008.metrics.debtServicePerGpuHr.value).toBeCloseTo(2.262, 2);
    expect(l1008.metrics.statedLtv.value).toBeCloseTo(0.7, 2);
    expect(l1008.status).toBe("Active");
    expect(l1008.repayments.count.value).toBe(1);
    expect(l1008.repayments.health).toBe("current");
    expect(l1008.daysToMaturity.value).toBeGreaterThan(1000);
  });

  it("derives breakeven and coverage from the archived B300 price", () => {
    const price = prices.models.B300.medianUsdPerGpuHr!;
    expect(l1008.metrics.marketPerGpuHr.value).toBeCloseTo(price, 3);
    expect(l1008.metrics.breakevenUtilization.value).toBeCloseTo(l1008.metrics.debtServicePerGpuHr.value! / price, 3);
    expect(l1008.metrics.coverageAtAssumedUtilization.value).toBeCloseTo((price * 0.7) / l1008.metrics.debtServicePerGpuHr.value!, 2);
    expect(l1008.metrics.depreciatedLtv.value!).toBeGreaterThan(l1008.metrics.statedLtv.value!);
  });

  it("gives every number a checkable source", () => {
    expect(l1008.principalUsd.source).toMatch(/^https:\/\/arbiscan\.io\/tx\/0x[0-9a-f]{64}$/);
    expect(l1008.collateral?.valueUsd.source).toBe("https://metadata.usd.ai/v1/1008");
    expect(l1008.metrics.marketPerGpuHr.source).toMatch(/data\/gpu-prices\/2026-10-12\.json/);
    expect(l1008.links.collateral).toMatch(/arbiscan\.io\/nft\/0xb31f04f920f24eda3ad276d55c5afefad6230c5d\/1008$/);
  });

  it("summarizes the book and its closed loans", () => {
    expect(snap.book.activeLoans).toBe(snap.loans.length);
    expect(snap.book.outstandingUsd.value).toBeCloseTo(snap.loans.reduce((s, l) => s + (l.outstandingUsd.value ?? 0), 0), 0);
    expect(snap.book.byModel.find((m) => m.key === "B300")?.gpus).toBe(1040);
    expect(snap.book.topBorrower?.share).toBeGreaterThan(0);
    expect(snap.closedLoans.length).toBeGreaterThan(0);
  });

  it("flags loans whose breakeven utilization is above the threshold", () => {
    expect(snap.book.flagged.find((f) => f.id === "1008")).toBeUndefined();
    const strict = buildSnapshot({ ...inputs, assumptions: { ...DEFAULT_ASSUMPTIONS, breakevenFlag: 0.1 } });
    expect(strict.book.flagged.find((f) => f.id === "1008")?.flags[0]).toMatch(/breakeven utilization \d+% is above 10%/);
  });

  it("reports missing prices and missing collateral as gaps, not as zeros", () => {
    const bare = buildSnapshot({ ...inputs, prices: null, collateral: new Map() });
    const l = bare.loans.find((x) => x.id === "1008")!;
    expect(l.metrics.debtServicePerGpuHr.value).toBeNull();
    expect(l.metrics.breakevenUtilization.value).toBeNull();
    expect(bare.unavailable).toContain("public price for B300");
  });
});

describe("validateSnapshot", () => {
  it("accepts the committed data/monitor/latest.json", () => {
    const committed = JSON.parse(readFileSync(new URL("../../../data/monitor/latest.json", import.meta.url), "utf8"));
    expect(validateSnapshot(committed)).toEqual([]);
  });

  it("reports what is wrong", () => {
    expect(validateSnapshot(null)).toEqual(["snapshot is not an object"]);
    const snap = buildSnapshot(inputs);
    const broken = { ...snap, loans: [{ ...snap.loans[0]!, aprPct: { value: 8.5, source: "" } }] };
    expect(validateSnapshot(broken)).toEqual(["loan 0 has a number without a source"]);
    expect(validateSnapshot({ ...snap, schema: "x" })).toContain("schema is not plumbline.monitor/v1");
  });
});
