import { readFileSync } from "node:fs";
import { proofToObservation } from "../claim.js";
import { loadEnv, optionalEnv } from "../env.js";
import { invoiceSpecFromConfig } from "../specs.js";
import { assertSigned, proveSource } from "../zk.js";

// Day 1 gating test: prove a real GPU invoice, revealing only price fields and a hashed id.
loadEnv();
const configPath = process.argv[2];
if (!configPath) throw new Error("usage: npm run prove:invoice -- sources/<provider>.json");
const spec = invoiceSpecFromConfig(JSON.parse(readFileSync(configPath, "utf8")));
const secrets = { authHeader: optionalEnv("INVOICE_AUTH_HEADER"), cookie: optionalEnv("INVOICE_COOKIE") };
if (!secrets.authHeader && !secrets.cookie) throw new Error("set INVOICE_AUTH_HEADER or INVOICE_COOKIE in .env");

const run = await proveSource(spec, secrets);
await assertSigned(run.proof);
const obs = proofToObservation(run.proof, [spec]);
console.log(
  JSON.stringify(
    {
      source: spec.id,
      proofFile: run.path,
      elapsedMs: run.elapsedMs,
      proofBytes: run.bytes,
      revealed: run.proof.extractedParameterValues,
      usdPerGpuHour: obs.microUsdPerGpuHour / 1_000_000,
      nullifier: obs.nullifier,
    },
    null,
    2,
  ),
);
