import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReclaimClient } from "@reclaimprotocol/zk-fetch";
import { assertVerifiedProof, getAttestors, type Proof } from "@reclaimprotocol/js-sdk";
import { requireEnv } from "./env.js";
import { buildZkFetchRequest, type Secrets } from "./request.js";
import type { SourceSpec } from "./specs.js";

export interface ProofRun {
  readonly proof: Proof;
  readonly elapsedMs: number;
  readonly bytes: number;
  readonly path: string;
}

export function makeClient(): ReclaimClient {
  return new ReclaimClient(requireEnv("RECLAIM_APP_ID"), requireEnv("RECLAIM_APP_SECRET"));
}

/** Runs zkFetch for a spec, times it, and saves the proof JSON under proofs/. */
export async function proveSource(spec: SourceSpec, secrets: Secrets = {}, outDir = "proofs"): Promise<ProofRun> {
  const client = makeClient();
  const req = buildZkFetchRequest(spec, secrets);
  const started = Date.now();
  const proof = await client.zkFetch(req.url, req.publicOptions, req.secretOptions, 3, 5_000);
  const elapsedMs = Date.now() - started;
  if (!proof) throw new Error(`zkFetch returned no proof for ${spec.id}`);
  const json = JSON.stringify(proof, null, 2);
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${spec.id}-${proof.claimData.timestampS}.json`);
  writeFileSync(path, json);
  return { proof: proof as unknown as Proof, elapsedMs, bytes: Buffer.byteLength(json), path };
}

/** Throws unless the proof is signed by a current Reclaim attestor. */
export async function assertSigned(proof: Proof): Promise<void> {
  await assertVerifiedProof(proof, await getAttestors());
}
