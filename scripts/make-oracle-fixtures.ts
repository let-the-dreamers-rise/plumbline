import { mkdirSync, writeFileSync } from "node:fs";
import { createSignDataForClaim, getIdentifierFromClaimInfo } from "@reclaimprotocol/js-sdk";
import { Wallet, keccak256, toUtf8Bytes } from "ethers";

// Generates Reclaim-format claims signed by a deterministic TEST attestor key, using Reclaim's own
// sign-data and identifier code, so the Rust program is tested against the real wire format.

const TEST_ATTESTOR = new Wallet(keccak256(toUtf8Bytes("pct-test-attestor")));
const OWNER = "0x" + "ab".repeat(20);
const TIMESTAMP_S = 1_790_900_000;

interface FixtureSpec {
  name: string;
  provider: number;
  kind: 0 | 1;
  gpuCount: number;
  valueMode: 0 | 1;
  requiresNullifier: boolean;
  url: string;
  matches: string[];
  extracted: Record<string, string>;
  expectedMicro: number;
}

const SPECS: FixtureSpec[] = [
  {
    name: "lambda-invoice", provider: 1, kind: 0, gpuCount: 1, valueMode: 1, requiresNullifier: true,
    url: "https://cloud.lambda.example/api/invoices", matches: ['"amount":"(?<amount>[0-9.]+)","hours":(?<hours>[0-9.]+)', '"id":"(?<account>[^"]+)"'],
    extracted: { account: "0x" + "11".repeat(32), amount: "4.98", hours: "2" }, expectedMicro: 2_490_000,
  },
  {
    name: "runpod-invoice", provider: 2, kind: 0, gpuCount: 1, valueMode: 0, requiresNullifier: true,
    url: "https://api.runpod.example/billing", matches: ['"costPerHr":(?<rate>[0-9.]+)', '"podId":"(?<account>[^"]+)"'],
    extracted: { account: "0x" + "22".repeat(32), rate: "2.69" }, expectedMicro: 2_690_000,
  },
  {
    name: "vast-invoice", provider: 3, kind: 0, gpuCount: 8, valueMode: 0, requiresNullifier: true,
    url: "https://console.vast.example/api/v0/invoices", matches: ['"dph_total":(?<rate>[0-9.]+)', '"contract":"(?<account>[^"]+)"'],
    extracted: { account: "0x" + "33".repeat(32), rate: "16.8" }, expectedMicro: 2_100_000,
  },
  {
    name: "sfc-invoice", provider: 4, kind: 0, gpuCount: 1, valueMode: 0, requiresNullifier: true,
    url: "https://sfcompute.example/v0/orders", matches: ['"price":(?<rate>[0-9.]+)', '"order":"(?<account>[^"]+)"'],
    extracted: { account: "0x" + "44".repeat(32), rate: "2.80" }, expectedMicro: 2_800_000,
  },
  {
    name: "azure-list", provider: 5, kind: 1, gpuCount: 8, valueMode: 0, requiresNullifier: false,
    url: "https://prices.azure.com/api/retail/prices", matches: ['"retailPrice":(?<rate>[0-9]+(?:\\.[0-9]+)?),"unitPrice"'],
    extracted: { rate: "98.32" }, expectedMicro: 12_290_000,
  },
];

function sortedJson(value: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)));
  return JSON.stringify(sorted);
}

const claims = await Promise.all(
  SPECS.map(async (s) => {
    const parameters = JSON.stringify({
      body: "",
      method: "GET",
      responseMatches: s.matches.map((value) => ({ type: "regex", value })),
      responseRedactions: s.matches.map((regex) => ({ regex })),
      url: s.url,
    });
    const context = sortedJson({
      contextAddress: "0x0000000000000000000000000000000000000000",
      contextMessage: 'note "rate":"0.01" injection attempt',
      extractedParameters: Object.fromEntries(Object.entries(s.extracted).sort(([a], [b]) => (a < b ? -1 : 1))),
      providerHash: "0x" + "00".repeat(32),
    });
    const claim = { provider: "http", parameters, context, owner: OWNER, timestampS: TIMESTAMP_S, epoch: 1 };
    const identifier = getIdentifierFromClaimInfo(claim);
    const manual = keccak256(toUtf8Bytes(`http\n${parameters}\n${context}`)).toLowerCase();
    if (identifier !== manual) throw new Error(`context for ${s.name} is not canonical`);
    const signature = await TEST_ATTESTOR.signMessage(createSignDataForClaim(claim));
    return {
      ...s,
      claimProvider: "http",
      parameters,
      context,
      owner: OWNER,
      timestampS: TIMESTAMP_S,
      epoch: 1,
      identifier,
      signature,
      paramsHash: keccak256(toUtf8Bytes(parameters)),
    };
  }),
);

const out = "oracle/programs/pct_oracle/tests/fixtures";
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/claims.json`, JSON.stringify({ attestor: TEST_ATTESTOR.address.toLowerCase(), claims }, null, 2));
console.log(`wrote ${claims.length} claims signed by test attestor ${TEST_ATTESTOR.address}`);
