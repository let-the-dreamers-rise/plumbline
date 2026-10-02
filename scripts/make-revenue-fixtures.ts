import { mkdirSync, writeFileSync } from "node:fs";
import { createSignDataForClaim, getIdentifierFromClaimInfo } from "@reclaimprotocol/js-sdk";
import { Wallet, keccak256, toUtf8Bytes } from "ethers";

// Operator revenue claims (host payouts, Stripe balance) signed by the same deterministic TEST
// attestor as make-oracle-fixtures.ts, using Reclaim's own sign-data and identifier code.

const TEST_ATTESTOR = new Wallet(keccak256(toUtf8Bytes("pct-test-attestor")));
const OWNER = "0x" + "ab".repeat(20);
const PERIOD_S = 604_800;
const WEEK0 = 2961 * PERIOD_S; // 2026-09-24 00:00 UTC
const OP1 = "0x" + "a1".repeat(32);
const OP2 = "0x" + "b2".repeat(32);

interface RevenueSource {
  name: string;
  provider: number;
  url: string;
  matches: string[];
}

const SOURCES: RevenueSource[] = [
  {
    name: "vast-host-payout",
    provider: 3,
    url: "https://console.vast.ai/api/v0/users/me/host-earnings",
    matches: ['"earnings":(?<amount>[0-9.]+)', '"gpu_hours":(?<hours>[0-9.]+)', '"host_id":"(?<account>[^"]+)"'],
  },
  {
    name: "stripe-balance",
    provider: 11,
    url: "https://api.stripe.com/v1/balance_transactions",
    matches: ['"net_total":(?<amount>[0-9.]+)', '"account":"(?<account>[^"]+)"'],
  },
];

const CLAIMS = [
  { name: "op1-vast-w0", source: "vast-host-payout", at: WEEK0 + 3_600, extracted: { account: OP1, amount: "2580.48", hours: "1075.2" } },
  { name: "op1-stripe-w0", source: "stripe-balance", at: WEEK0 + 7_200, extracted: { account: OP1, amount: "400" } },
  { name: "op1-vast-w1", source: "vast-host-payout", at: WEEK0 + PERIOD_S + 3_600, extracted: { account: OP1, amount: "360", hours: "150" } },
  { name: "op2-vast-w0", source: "vast-host-payout", at: WEEK0 + 3_600, extracted: { account: OP2, amount: "999", hours: "400" } },
];

const parametersOf = (s: RevenueSource) =>
  JSON.stringify({
    body: "",
    method: "GET",
    responseMatches: s.matches.map((value) => ({ type: "regex", value })),
    responseRedactions: s.matches.map((regex) => ({ regex })),
    url: s.url,
  });

const claims = await Promise.all(
  CLAIMS.map(async (c) => {
    const source = SOURCES.find((s) => s.name === c.source)!;
    const parameters = parametersOf(source);
    const context = JSON.stringify({
      contextAddress: "0x0000000000000000000000000000000000000000",
      contextMessage: "",
      extractedParameters: Object.fromEntries(Object.entries(c.extracted).sort(([a], [b]) => (a < b ? -1 : 1))),
      providerHash: "0x" + "00".repeat(32),
    });
    const claim = { provider: "http", parameters, context, owner: OWNER, timestampS: c.at, epoch: 1 };
    const identifier = getIdentifierFromClaimInfo(claim);
    const signature = await TEST_ATTESTOR.signMessage(createSignDataForClaim(claim));
    return { ...c, claimProvider: "http", parameters, context, owner: OWNER, timestampS: c.at, epoch: 1, identifier, signature };
  }),
);

const out = "oracle/programs/pct_oracle/tests/fixtures";
mkdirSync(out, { recursive: true });
const sources = SOURCES.map((s) => ({ ...s, paramsHash: keccak256(toUtf8Bytes(parametersOf(s))) }));
writeFileSync(
  `${out}/revenue.json`,
  JSON.stringify({ attestor: TEST_ATTESTOR.address.toLowerCase(), periodS: PERIOD_S, operators: { op1: OP1, op2: OP2 }, sources, claims }, null, 2),
);
console.log(`wrote ${claims.length} revenue claims signed by test attestor ${TEST_ATTESTOR.address}`);
