import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AZURE_H100_LIST, invoiceSpecFromConfig, proofToObservation, type SourceSpec } from "@pct/prover";
import type { ReclaimProof } from "../claim.js";

/** Registered specs: the Azure list smoke-test source plus every sources/*.json except the example. */
export function loadSpecs(dir = "sources"): SourceSpec[] {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("example")) : [];
  return [AZURE_H100_LIST, ...files.map((f) => invoiceSpecFromConfig(JSON.parse(readFileSync(join(dir, f), "utf8"))))];
}

export interface LoadedProof {
  file: string;
  proof: ReclaimProof;
  spec: SourceSpec;
}

/** Every proofs/*.json that matches a registered spec's URL and enforced rules; others are reported and skipped. */
export function loadProofs(specs: readonly SourceSpec[], dir = "proofs"): LoadedProof[] {
  if (!existsSync(dir)) return [];
  const out: LoadedProof[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const proof = JSON.parse(readFileSync(join(dir, file), "utf8")) as ReclaimProof;
    try {
      proofToObservation(proof as unknown as Parameters<typeof proofToObservation>[0], specs);
      const url = (JSON.parse(proof.claimData.parameters) as { url: string }).url;
      out.push({ file, proof, spec: specs.find((s) => url.startsWith(s.urlPrefix))! });
    } catch (err) {
      console.log(`skip ${file}: ${(err as Error).message}`);
    }
  }
  return out;
}
