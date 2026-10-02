import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { getBytes, keccak256, toUtf8Bytes } from "ethers";
import { Writer, discriminator } from "./borsh.js";
import { operatorKey, revenuePeriod, revenueReceiptKeyFor } from "./claim.js";
import { LOAN_HISTORY, OracleInstructions, decodeLoan, revenueItemKey, revenueReceiptKey, trailingCoverageBps } from "./program.js";
import { REVENUE_SOURCES, revenueParameters, signTestRevenueClaim, STRIPE_PAYOUT, VAST_HOST_PAYOUT } from "./revenue.js";

interface RevenueFixtures {
  periodS: number;
  operators: Record<string, string>;
  sources: { name: string; paramsHash: string }[];
  claims: { name: string; context: string; timestampS: number }[];
}
const fx = JSON.parse(readFileSync("oracle/programs/pct_oracle/tests/fixtures/revenue.json", "utf8")) as RevenueFixtures;
const WEEK = 604_800;

const loanAccount = (history: [number, bigint, bigint, number][]): Buffer => {
  const w = new Writer().raw(discriminator("account", "Loan"));
  w.raw(new Uint8Array(32).fill(1)).raw(new Uint8Array(32).fill(2)).raw(new Uint8Array(32).fill(3));
  w.u8(0).u16(8).u32(WEEK).u64(1_500_000_000n).u16(11_500).u64(5n);
  for (let i = 0; i < LOAN_HISTORY; i++) {
    const [period, rev, hours, proofs] = history[i] ?? [0, 0n, 0n, 0];
    w.u32(period).u64(rev).u64(hours).u8(proofs);
  }
  return w.i64(42).u8(255).bytes();
};

describe("loans", () => {
  it("decodes a Loan and keeps proven periods in order", () => {
    const loan = decodeLoan(
      loanAccount([
        [12, 1_440_000_000n, 0n, 1],
        [10, 2_580_480_000n, 1_075_200_000n, 2],
      ]),
    );
    expect(loan.history.map((p) => p.period)).toEqual([10, 12]);
    expect([loan.fleetGpus, loan.periodS, loan.minCoverageBps, loan.drawnLamports, loan.updatedAt]).toEqual([8, WEEK, 11_500, 5n, 42n]);
  });

  it("computes trailing coverage like Loan::trailing_coverage_bps", () => {
    const loan = decodeLoan(
      loanAccount([
        [10, 2_580_480_000n, 0n, 1],
        [12, 1_440_000_000n, 0n, 1],
      ]),
    );
    expect(trailingCoverageBps(loan, 10)).toBe(17_203n);
    expect(trailingCoverageBps(loan, 12)).toBe(8_934n); // the unproven week 11 counts as zero
  });

  it("pins the same source hashes as the Rust fixtures", () => {
    for (const s of REVENUE_SOURCES) {
      expect(fx.sources.find((f) => f.name === s.name)?.paramsHash).toBe(keccak256(toUtf8Bytes(revenueParameters(s))));
    }
  });

  it("keys Stripe payouts by payout id and Vast statements by period", async () => {
    const op = operatorKey(fx.operators.op1!);
    const payout = await signTestRevenueClaim(STRIPE_PAYOUT, { account: "x", amount_cents: "100", at: String(3 * WEEK + 5), item: "po_1" }, 4 * WEEK);
    expect(revenuePeriod(payout, WEEK)).toBe(3);
    expect(revenueReceiptKeyFor(payout, op, WEEK)).toEqual(revenueItemKey(op, "po_1"));
    const vast = await signTestRevenueClaim(VAST_HOST_PAYOUT, { account: "x", amount: "1", hours: "1" }, 4 * WEEK + 9);
    expect(revenueReceiptKeyFor(vast, op, WEEK)).toEqual(revenueReceiptKey(op, 4));
  });

  it("builds submit_revenue with the receipt PDA for that key", () => {
    const ix = new OracleInstructions();
    const op = getBytes(keccak256("0x01"));
    const me = Keypair.generate().publicKey;
    const key = revenueReceiptKey(op, 7);
    const sig = { owner: "0xab", timestampS: 1, epoch: 1, signature: new Uint8Array(65) };
    const sourceId = new Uint8Array(32);
    const built = ix.submitRevenue(me, sourceId, { operatorKey: op, sku: 0 }, sig, key);
    expect(built.keys[3]!.pubkey.equals(ix.pdas.loan(op))).toBe(true);
    expect(built.keys[6]!.pubkey.equals(ix.pdas.receipt(ix.pdas.source(sourceId), key))).toBe(true);
    expect(built.data.subarray(built.data.length - 32)).toEqual(Buffer.from(key));
  });
});
