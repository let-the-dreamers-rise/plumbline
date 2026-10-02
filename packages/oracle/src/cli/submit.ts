import { sourceArgsFor } from "../claim.js";
import { clientFromEnv } from "../env.js";
import { programError } from "../client.js";
import { loadProofs, loadSpecs } from "./load.js";

// Submits every proof in proofs/ to the oracle. Reused invoices and already-submitted proofs are
// rejected by the program's receipt accounts and reported, not retried.
const client = clientFromEnv();
let ok = 0;
for (const { file, proof, spec } of loadProofs(loadSpecs())) {
  try {
    const r = await client.submitProof(proof, sourceArgsFor(spec, proof.claimData.parameters));
    ok++;
    console.log(`ok   ${file}  ${spec.id}  ${r.computeUnits ?? "?"} CU  ${r.signature}`);
  } catch (err) {
    const why = programError(err);
    const hint = why.includes("already in use") ? " (already submitted)" : why.includes("ParamsMismatch") ? " (proof parameters differ from the registered source)" : "";
    console.log(`FAIL ${file}  ${spec.id}  ${why}${hint}`);
  }
}
console.log(`${ok} submitted. Run npm run oracle:crank to update the index.`);
