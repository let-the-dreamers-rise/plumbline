import { getBytes } from "ethers";
import { attestorsOf, sourceArgsFor } from "../claim.js";
import { clientFromEnv } from "../env.js";
import { DEFAULT_INDEX_PARAMS } from "../program.js";
import { loadProofs, loadSpecs } from "./load.js";

// Sets up a deployed pct_oracle: config (attestors from your proofs, or PCT_ATTESTORS), one book per
// (sku, kind) in use, and one source per spec, pinned to the parameters of the first proof of it.
const client = clientFromEnv();
const proofs = loadProofs(loadSpecs());
if (proofs.length === 0) throw new Error("no usable proofs in proofs/. Run npm run prove:list or prove:invoice first.");

const fromEnv = process.env.PCT_ATTESTORS?.split(",").map((a) => getBytes(a.trim())) ?? [];
const attestors = fromEnv.length > 0 ? fromEnv : attestorsOf(proofs.map((p) => p.proof));
if (attestors.length === 0) throw new Error("proofs carry no witnesses; set PCT_ATTESTORS=0x...");
await client.upsertConfig(attestors, DEFAULT_INDEX_PARAMS);
console.log(`config ${client.ix.pdas.config().toBase58()} attestors=${attestors.map((a) => Buffer.from(a).toString("hex")).join(",")}`);

const seen = new Set<string>();
for (const { file, proof, spec } of proofs) {
  if (seen.has(spec.id)) continue;
  seen.add(spec.id);
  const args = sourceArgsFor(spec, proof.claimData.parameters);
  await client.ensureBook(args.sku, args.kind);
  const tx = await client.ensureSource(args);
  console.log(`${tx ? "registered" : "exists   "} ${spec.id} (from ${file}) -> ${client.ix.pdas.source(args.sourceId).toBase58()}`);
}
