import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, requireEnv } from "../env.js";
import { assertRevenueProofMatches, buildRevenueRequest, revenueSpec } from "../revenue.js";
import { assertSigned, makeClient } from "../zk.js";
import type { Proof } from "@reclaimprotocol/js-sdk";

// Proves an operator's revenue from a third-party system of record, revealing only the amount,
// date, payout id and an OPRF hash of the account. Default source: the latest Stripe payout.
//   npm run prove:revenue            (Stripe; needs STRIPE_KEY=rk_test_... in .env)
//   npm run prove:revenue vast       (Vast host earnings; needs VAST_API_KEY)
loadEnv();
const spec = revenueSpec(process.argv[2] ?? "stripe");
const key = spec.name === "stripe-payout" ? requireEnv("STRIPE_KEY") : requireEnv("VAST_API_KEY");
const req = buildRevenueRequest(spec, `Bearer ${key}`);

const started = Date.now();
const proof = (await makeClient().zkFetch(req.url, req.publicOptions, req.secretOptions, 3, 5_000)) as unknown as Proof | undefined;
if (!proof) throw new Error(`zkFetch returned no proof for ${spec.name}`);
await assertSigned(proof);
assertRevenueProofMatches(proof.claimData.parameters, spec);

const dir = join("proofs", "revenue");
mkdirSync(dir, { recursive: true });
const path = join(dir, `${spec.name}-${proof.claimData.timestampS}.json`);
writeFileSync(path, JSON.stringify(proof, null, 2));
const revealed = (JSON.parse(proof.claimData.context) as { extractedParameters?: Record<string, string> }).extractedParameters;
console.log(JSON.stringify({ source: spec.name, proofFile: path, elapsedMs: Date.now() - started, revealed }, null, 2));
