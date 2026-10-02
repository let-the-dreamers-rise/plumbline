import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { computeIndex, DEFAULT_PARAMS, type Observation } from "@pct/core";
import type { Proof } from "@reclaimprotocol/js-sdk";
import { proofToObservation } from "../claim.js";
import { AZURE_H100_LIST, invoiceSpecFromConfig, type SourceSpec } from "../specs.js";
import { assertSigned } from "../zk.js";

// Verifies every proof in proofs/ against registered sources and prints the resulting index.
const sources: SourceSpec[] = [
  AZURE_H100_LIST,
  ...readdirSync("sources")
    .filter((f) => f.endsWith(".json") && !f.startsWith("example"))
    .map((f) => invoiceSpecFromConfig(JSON.parse(readFileSync(join("sources", f), "utf8")))),
];

const observations: Observation[] = [];
for (const file of readdirSync("proofs").filter((f) => f.endsWith(".json"))) {
  const proof = JSON.parse(readFileSync(join("proofs", file), "utf8")) as Proof;
  try {
    await assertSigned(proof);
    const obs = proofToObservation(proof, sources);
    observations.push(obs);
    console.log(`ok   ${file}  ${obs.kind} ${obs.provider} $${obs.microUsdPerGpuHour / 1e6}/GPU-hr`);
  } catch (err) {
    console.log(`FAIL ${file}  ${(err as Error).message}`);
  }
}

const nowS = Math.floor(Date.now() / 1000);
for (const kind of ["paid", "list"] as const) {
  const r = computeIndex(observations, "H100", kind, { ...DEFAULT_PARAMS, nowS });
  const value = r.valueMicroUsd === null ? "-" : `$${r.valueMicroUsd / 1e6}`;
  console.log(`H100 ${kind}: ${r.status} ${value} (${r.used.length} used, ${r.rejected.length} rejected) ${r.reason ?? ""}`);
}
