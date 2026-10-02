import { mkdirSync, writeFileSync } from "node:fs";
import { keccak256, toUtf8Bytes } from "ethers";
import {
  REVENUE_SOURCES,
  STRIPE_PAYOUT,
  TEST_ATTESTOR,
  VAST_HOST_PAYOUT,
  revenueParameters,
  signTestRevenueClaim,
} from "../packages/oracle/src/revenue.js";

// Operator revenue claims (Vast host payouts, Stripe payouts) for oracle/programs/pct_oracle/tests,
// signed by the same deterministic TEST attestor as make-oracle-fixtures.ts.

const PERIOD_S = 604_800;
const WEEK0 = 2961 * PERIOD_S; // Thu 2026-10-01 00:00 UTC (unix weeks start on Thursday)
const OP1 = "0x" + "a1".repeat(32);
const OP2 = "0x" + "b2".repeat(32);

const CLAIMS = [
  { name: "op1-vast-w0", source: VAST_HOST_PAYOUT, at: WEEK0 + 3_600, extracted: { account: OP1, amount: "2580.48", hours: "1075.2" } },
  {
    name: "op1-stripe-w0",
    source: STRIPE_PAYOUT,
    at: WEEK0 + 7_200,
    extracted: { account: OP1, amount_cents: "40000", at: String(WEEK0 + 3_600), item: "po_test_w0" },
  },
  {
    // The same payout proven again a week later must not count twice.
    name: "op1-stripe-w0-again",
    source: STRIPE_PAYOUT,
    at: WEEK0 + PERIOD_S + 7_200,
    extracted: { account: OP1, amount_cents: "40000", at: String(WEEK0 + 3_600), item: "po_test_w0" },
  },
  { name: "op1-vast-w1", source: VAST_HOST_PAYOUT, at: WEEK0 + PERIOD_S + 3_600, extracted: { account: OP1, amount: "360", hours: "150" } },
  { name: "op2-vast-w0", source: VAST_HOST_PAYOUT, at: WEEK0 + 3_600, extracted: { account: OP2, amount: "999", hours: "400" } },
];

const claims = await Promise.all(
  CLAIMS.map(async (c) => {
    const proof = await signTestRevenueClaim(c.source, c.extracted, c.at);
    const d = proof.claimData;
    return {
      name: c.name,
      source: c.source.name,
      at: c.at,
      extracted: c.extracted,
      claimProvider: d.provider,
      parameters: d.parameters,
      context: d.context,
      owner: d.owner,
      timestampS: d.timestampS,
      epoch: d.epoch,
      identifier: proof.identifier,
      signature: proof.signatures[0],
    };
  }),
);

const out = "oracle/programs/pct_oracle/tests/fixtures";
mkdirSync(out, { recursive: true });
const sources = REVENUE_SOURCES.map((s) => ({ ...s, paramsHash: keccak256(toUtf8Bytes(revenueParameters(s))) }));
writeFileSync(
  `${out}/revenue.json`,
  JSON.stringify({ attestor: TEST_ATTESTOR.address.toLowerCase(), periodS: PERIOD_S, operators: { op1: OP1, op2: OP2 }, sources, claims }, null, 2),
);
console.log(`wrote ${claims.length} revenue claims signed by test attestor ${TEST_ATTESTOR.address}`);
