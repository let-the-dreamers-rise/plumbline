import { mkdirSync, writeFileSync } from "node:fs";
import { keccak256, toUtf8Bytes } from "ethers";
import {
  RAZORPAY_PAYMENT,
  REVENUE_SOURCES,
  STRIPE_PAYOUT_TEST,
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
// Razorpay responses carry no account id, so those loans bind to the claim owner (the Reclaim app).
const RZP_OWNER = "0x" + "cd".repeat(20);
const OTHER_OWNER = "0x" + "ee".repeat(20);

const CLAIMS = [
  { name: "op1-vast-wm1", source: VAST_HOST_PAYOUT, at: WEEK0 - PERIOD_S + 3_600, extracted: { account: OP1, amount: "2580.48", hours: "1075.2" } },
  { name: "op1-vast-w0", source: VAST_HOST_PAYOUT, at: WEEK0 + 3_600, extracted: { account: OP1, amount: "2580.48", hours: "1075.2" } },
  {
    name: "op1-stripe-w0",
    source: STRIPE_PAYOUT_TEST,
    at: WEEK0 + 7_200,
    extracted: { account: OP1, amount_cents: "40000", currency: "usd", at: String(WEEK0 + 3_600), item: "po_test_w0" },
  },
  {
    // Minor units without a currency: refused rather than assumed to be USD cents.
    name: "op1-stripe-nocurrency",
    source: STRIPE_PAYOUT_TEST,
    at: WEEK0 + 7_250,
    extracted: { account: OP1, amount_cents: "40000", at: String(WEEK0 + 3_600), item: "po_test_nc" },
  },
  {
    // The same payout proven again a week later must not count twice.
    name: "op1-stripe-w0-again",
    source: STRIPE_PAYOUT_TEST,
    at: WEEK0 + PERIOD_S + 7_200,
    extracted: { account: OP1, amount_cents: "40000", currency: "usd", at: String(WEEK0 + 3_600), item: "po_test_w0" },
  },
  { name: "op1-vast-w1", source: VAST_HOST_PAYOUT, at: WEEK0 + PERIOD_S + 3_600, extracted: { account: OP1, amount: "360", hours: "150" } },
  { name: "op2-vast-w0", source: VAST_HOST_PAYOUT, at: WEEK0 + 3_600, extracted: { account: OP2, amount: "999", hours: "400" } },
  {
    name: "rzp-w0",
    source: RAZORPAY_PAYMENT,
    at: WEEK0 + 7_200,
    owner: RZP_OWNER,
    extracted: { item: "pay_TestW0", amount_cents: "25000000", currency: "INR", at: String(WEEK0 + 3_600) },
  },
  {
    // Same merchant data proven through someone else's Reclaim app: not this loan's operator.
    name: "rzp-w0-other-owner",
    source: RAZORPAY_PAYMENT,
    at: WEEK0 + 7_300,
    owner: OTHER_OWNER,
    extracted: { item: "pay_TestW0b", amount_cents: "25000000", currency: "INR", at: String(WEEK0 + 3_600) },
  },
  {
    name: "rzp-w0-usd",
    source: RAZORPAY_PAYMENT,
    at: WEEK0 + 7_400,
    owner: RZP_OWNER,
    extracted: { item: "pay_TestW0c", amount_cents: "100000", currency: "USD", at: String(WEEK0 + 3_600) },
  },
];

const claims = await Promise.all(
  CLAIMS.map(async (c) => {
    const proof = await signTestRevenueClaim(c.source, c.extracted, c.at, "owner" in c ? c.owner : undefined);
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
  JSON.stringify({ attestor: TEST_ATTESTOR.address.toLowerCase(), periodS: PERIOD_S, operators: { op1: OP1, op2: OP2, rzp: RZP_OWNER }, sources, claims }, null, 2),
);
console.log(`wrote ${claims.length} revenue claims signed by test attestor ${TEST_ATTESTOR.address}`);
