import { proofToObservation } from "../claim.js";
import { loadEnv } from "../env.js";
import { AZURE_H100_LIST } from "../specs.js";
import { assertSigned, proveSource } from "../zk.js";

// Day 1 smoke test: prove the public Azure H100 list price and report latency and size.
loadEnv();
const run = await proveSource(AZURE_H100_LIST);
await assertSigned(run.proof);
const obs = proofToObservation(run.proof, [AZURE_H100_LIST]);
console.log(
  JSON.stringify(
    {
      source: AZURE_H100_LIST.id,
      proofFile: run.path,
      elapsedMs: run.elapsedMs,
      proofBytes: run.bytes,
      signatureCheck: "ok",
      usdPerGpuHour: obs.microUsdPerGpuHour / 1_000_000,
      observedAt: new Date(obs.observedAtS * 1000).toISOString(),
    },
    null,
    2,
  ),
);
