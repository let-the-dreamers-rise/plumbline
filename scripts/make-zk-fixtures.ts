import { mkdirSync, writeFileSync } from "node:fs";
import { Wallet, keccak256, toUtf8Bytes } from "ethers";
import { createSignDataForClaim } from "@reclaimprotocol/js-sdk";
import { RAZORPAY_PAYMENT, TEST_ATTESTOR, revenueParameters, signTestRevenueClaim } from "../packages/oracle/src/revenue.js";

// Razorpay revenue claims for the zk covenant guest (zk/fixtures/revenue-claims.json), each signed by
// two deterministic TEST attestors so the guest's 2-of-n rule is exercised. Test keys only.

const PERIOD_S = 604_800;
const AS_OF = 2961; // week of Thu 2026-10-01
const OWNER = "0x" + "cd".repeat(20); // operator's Reclaim app (Razorpay responses carry no merchant id)
const SECOND = new Wallet(keccak256(toUtf8Bytes("pct-test-attestor-2")));
const OUTSIDER = new Wallet(keccak256(toUtf8Bytes("pct-not-an-attestor")));

async function claim(item: string, rupees: number, week: number, signers: Wallet[]) {
  const at = (AS_OF - week) * PERIOD_S + 86_400;
  const extracted = { item, amount_cents: String(rupees * 100), currency: "INR", at: String(at) };
  const proof = await signTestRevenueClaim(RAZORPAY_PAYMENT, extracted, at + 3_600, OWNER);
  const c = proof.claimData;
  const data = createSignDataForClaim(c);
  const signatures = [];
  for (const s of signers) signatures.push(s === TEST_ATTESTOR ? proof.signatures[0] : await s.signMessage(data));
  return { provider: c.provider, parameters: c.parameters, context: c.context, owner: c.owner, timestamp_s: c.timestampS, epoch: c.epoch, signatures };
}

const both = [TEST_ATTESTOR, SECOND];
const strong = [await claim("pay_W3a", 160_000, 3, both), await claim("pay_W2a", 155_000, 2, both), await claim("pay_W1a", 170_000, 1, both), await claim("pay_W0a", 165_000, 0, both)];
const weak = [await claim("pay_X3a", 110_000, 3, both), await claim("pay_X2a", 115_000, 2, both), await claim("pay_X1a", 100_000, 1, both), await claim("pay_X0a", 120_000, 0, both)];

const out = {
  attestors: { threshold: 2, attestors: [TEST_ATTESTOR.address.toLowerCase(), SECOND.address.toLowerCase()] },
  paramsHash: keccak256(toUtf8Bytes(revenueParameters(RAZORPAY_PAYMENT))),
  terms: {
    operator_key: keccak256(toUtf8Bytes(OWNER)),
    currency: "INR",
    period_s: PERIOD_S,
    debt_service_micro: 120_000_000_000,
    min_coverage_bps: 11_500,
    covenant_periods: 4,
    as_of_period: AS_OF,
  },
  strong,
  weak,
  oneSigner: await claim("pay_S1", 160_000, 1, [TEST_ATTESTOR]),
  outsiderSigned: await claim("pay_S2", 160_000, 1, [TEST_ATTESTOR, OUTSIDER]),
};
mkdirSync("zk/fixtures", { recursive: true });
writeFileSync("zk/fixtures/revenue-claims.json", JSON.stringify(out, null, 2) + "\n");
console.log(`wrote zk/fixtures/revenue-claims.json: ${strong.length} strong, ${weak.length} weak claims`);
