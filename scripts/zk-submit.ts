import { readFileSync } from "node:fs";
import { ComputeBudgetProgram, PublicKey, Transaction } from "@solana/web3.js";
import { getBytes, keccak256, toUtf8Bytes } from "ethers";
import { clientFromEnv } from "../packages/oracle/src/env.js";

// Operator side of the product: submit your own Groth16 proof (zk/risc0 host, `groth16` mode) against
// the challenge your lender issued. The proof pays the treasury's proof fee, PASS or WATCH.
//
//   npm run zk:submit -- <proof.json> <lender> <operator-key hex> <as-of period> [source name, default razorpay-zk]
const [proofPath, lender, operatorKey, asOf, sourceName = "razorpay-zk"] = process.argv.slice(2);
if (!proofPath || !lender || !operatorKey || !asOf) {
  console.error("usage: npm run zk:submit -- <proof.json> <lender> <operator-key hex> <as-of period> [source name]");
  process.exit(2);
}
const client = clientFromEnv();
const proof = JSON.parse(readFileSync(proofPath, "utf8")) as { seal: string; journal: string };
const loan = { lender: new PublicKey(lender), operatorKey: getBytes(operatorKey) };
const sourceId = getBytes(keccak256(toUtf8Bytes(sourceName)));
const tx = new Transaction().add(
  ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
  client.ix.proveCovenant(client.payer.publicKey, sourceId, loan, getBytes(proof.seal), getBytes(proof.journal), Number(asOf)),
);
const sig = await client.connection.sendTransaction(tx, [client.payer]);
await client.connection.confirmTransaction(sig, "confirmed");
const address = client.ix.pdas.loan(loan.lender, loan.operatorKey).toBase58();
console.log(`proved: ${sig}\nverify page: /loan/${address}`);
