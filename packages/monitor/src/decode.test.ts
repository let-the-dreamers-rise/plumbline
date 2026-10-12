import { describe, expect, it } from "vitest";
import { buildBook, exclusionReason, originalPrincipal, outstandingPrincipal, phaseOf, rootOf, withCalldataTerms, withTimestamps } from "./book.js";
import { COLLATERAL_NFT, SUSDAI, USDAI } from "./constants.js";
import { aprOf, decodeLog, decodeLoanState, decodeV1BorrowCalldata, principalOf, TOPICS, tokens, type RawLog, type RouterEvent } from "./decode.js";
import { fixtureJson } from "./fixtures.js";

const logs = fixtureJson<RawLog[]>("router-logs.json");
const byTopic = (t: string) => logs.find((l) => l.topics[0]!.toLowerCase() === t)!;

describe("decodeLog on recorded Arbitrum logs", () => {
  it("decodes LoanOriginated with encoded terms (loan 1008)", () => {
    const e = decodeLog(byTopic(TOPICS.originated));
    expect(e?.kind).toBe("originated");
    if (e?.kind !== "originated" || !e.terms) throw new Error("no terms");
    expect(e.terms.collateralTokenIds).toEqual(["1008"]);
    expect(e.terms.collateralToken).toBe(COLLATERAL_NFT);
    expect(e.terms.currencyToken).toBe(USDAI);
    expect(e.terms.termDays).toBe(1095);
    expect(e.terms.repaymentIntervalS).toBe(30 * 86_400);
    expect(e.terms.tranches[0]!.lender).toBe(SUSDAI);
    expect(tokens(principalOf(e.terms))).toBeCloseTo(54_404_473, -1);
    expect(aprOf(e.terms)).toBeCloseTo(0.085, 4);
    expect(e.router).toBe("0x1c2ed170de32846316784c4fd58a5e3c7563e12f");
    expect(e.tx).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("ignores placeholder tranches when computing principal and APR", () => {
    const e = decodeLog(byTopic(TOPICS.originated));
    if (e?.kind !== "originated" || !e.terms) throw new Error("no terms");
    expect(e.terms.tranches.length).toBeGreaterThanOrEqual(1);
    const withDust = { ...e.terms, tranches: [...e.terms.tranches, { lender: "0xdead", amount: 1n, ratePerSecond: 10n ** 17n }] };
    expect(principalOf(withDust)).toBe(principalOf(e.terms));
    expect(aprOf(withDust)).toBeCloseTo(aprOf(e.terms)!, 10);
  });

  it("decodes LoanMigrated, both LoanRefinanced versions, and the v1 migration marker", () => {
    const m = decodeLog(byTopic(TOPICS.migrated));
    expect(m?.kind).toBe("migrated");
    if (m?.kind === "migrated") expect(m.oldHash).not.toBe(m.hash);
    for (const t of [TOPICS.refinanced, TOPICS.refinancedV11]) {
      const r = decodeLog(byTopic(t));
      expect(r?.kind).toBe("refinanced");
      if (r?.kind === "refinanced") expect(r.terms.collateralToken).toBe(COLLATERAL_NFT);
    }
    expect(decodeLog(byTopic(TOPICS.migratedOut))?.kind).toBe("migratedOut");
  });

  it("decodes LoanRepaid, partial and final", () => {
    const repaid = logs.filter((l) => l.topics[0] === TOPICS.repaid).map(decodeLog);
    expect(repaid.map((e) => (e?.kind === "repaid" ? e.isRepaid : null)).sort()).toEqual([false, true]);
    const partial = repaid.find((e) => e?.kind === "repaid" && !e.isRepaid);
    if (partial?.kind !== "repaid") throw new Error("no partial repayment");
    expect(partial.interest > 0n).toBe(true);
    expect(partial.borrower).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("decodes the legacy LoanOriginated (principal only) and skips unrelated logs", () => {
    const e = decodeLog(byTopic(TOPICS.originatedLegacy));
    expect(e?.kind).toBe("originated");
    if (e?.kind === "originated") {
      expect(e.terms).toBeNull();
      expect(e.principal! > 0n).toBe(true);
      expect(e.borrower).toMatch(/^0x[0-9a-f]{40}$/);
    }
    const transfer = logs.find((l) => l.topics[0]!.startsWith("0xddf252ad"))!;
    expect(decodeLog(transfer)).toBeNull();
  });

  it("treats the RPC's zero blockTimestamp as unknown", () => {
    const e = decodeLog({ ...logs[0]!, topics: [TOPICS.breached, "0x" + "11".repeat(32)], data: "0x", blockTimestamp: "0x0" });
    expect(e?.kind).toBe("breached");
    expect(e?.timestamp).toBeNull();
  });
});

describe("decodeV1BorrowCalldata", () => {
  it("finds borrow() inside an ERC-4337 handleOps call", () => {
    const { input } = fixtureJson<{ input: string }>("tx-v1-borrow.json");
    const terms = decodeV1BorrowCalldata(input);
    expect(terms).not.toBeNull();
    expect(terms!.collateralTokenIds).toEqual(["3"]);
    expect(terms!.termDays).toBe(1);
    expect(terms!.tranches).toHaveLength(1);
  });

  it("returns null when there is no borrow call", () => {
    expect(decodeV1BorrowCalldata("0x12345678" + "00".repeat(64))).toBeNull();
  });
});

describe("decodeLoanState", () => {
  it("decodes a recorded loanState(bytes32) result", () => {
    const { result } = fixtureJson<{ result: string }>("loanstate-1008.json");
    const s = decodeLoanState(result);
    expect(s.status).toBe("Active");
    expect(s.repaymentCount).toBe(1);
    expect(s.originationTimestamp).toBeGreaterThan(1_780_000_000);
  });
});

describe("buildBook", () => {
  const meta = (block: number, tx: string) => ({ router: "0xr", block, tx, logIndex: 0, timestamp: null });
  const originated = decodeLog(byTopic(TOPICS.originated)) as Extract<RouterEvent, { kind: "originated" }>;
  const terms = originated.terms!;
  const events: RouterEvent[] = [
    { ...meta(1, "0xa"), kind: "originated", hash: "0x01", terms: null, borrower: "0xb", principal: 5n * 10n ** 24n },
    { ...meta(2, "0xb"), kind: "migrated", oldHash: "0x01", hash: "0x02", terms },
    { ...meta(3, "0xc"), kind: "repaid", hash: "0x02", borrower: "0xb", principal: 10n ** 24n, interest: 1n, prepayment: 10n ** 24n, fee: 0n, isRepaid: false },
    { ...meta(4, "0xd"), kind: "refinanced", oldHash: "0x02", hash: "0x03", terms },
    { ...meta(5, "0xe"), kind: "originated", hash: "0x04", terms, borrower: terms.borrower, principal: null },
    { ...meta(6, "0xf"), kind: "repaid", hash: "0x04", borrower: "0xb", principal: 0n, interest: 0n, prepayment: 0n, fee: 0n, isRepaid: true },
  ];

  it("follows migrations and refinances, and marks repaid loans", () => {
    const book = buildBook([...events].reverse());
    expect(book.map((r) => [r.hash, phaseOf(r)])).toEqual([
      ["0x01", "superseded"],
      ["0x02", "superseded"],
      ["0x03", "active"],
      ["0x04", "repaid"],
    ]);
    const active = book.find((r) => r.hash === "0x03")!;
    expect(rootOf(book, active).hash).toBe("0x01");
    expect(active.createdBy).toBe("refinanced");
  });

  it("computes outstanding principal from repayment events", () => {
    const book = buildBook(events);
    const migrated = book.find((r) => r.hash === "0x02")!;
    expect(outstandingPrincipal(migrated)).toBe(originalPrincipal(migrated) - 2n * 10n ** 24n);
    expect(originalPrincipal(book[0]!)).toBe(5n * 10n ** 24n);
  });

  it("attaches calldata terms and excludes non-USD.AI test loans", () => {
    const v1 = decodeV1BorrowCalldata(fixtureJson<{ input: string }>("tx-v1-borrow.json").input);
    const book = withCalldataTerms(buildBook(events.slice(0, 1)), new Map([["0xa", v1]]));
    expect(book[0]!.termsSource).toBe("calldata");
    expect(exclusionReason(book[0]!)).toMatch(/not the USD.AI Tokenized Hardware NFT/);
  });

  it("fills missing timestamps from block times without touching known ones", () => {
    const filled = withTimestamps([{ block: 1, timestamp: null }, { block: 2, timestamp: 7 }], new Map([[1, 100], [2, 200]]));
    expect(filled).toEqual([{ block: 1, timestamp: 100 }, { block: 2, timestamp: 7 }]);
  });
});
