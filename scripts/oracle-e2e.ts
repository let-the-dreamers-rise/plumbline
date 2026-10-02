import { readFileSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { DEFAULT_INDEX_PARAMS, OracleClient, programError } from "../packages/oracle/src/index.js";
import { fixtureProof, fixtureSource, type Fixtures } from "../packages/oracle/src/fixtures.js";
import { getBytes } from "ethers";

// End to end against a running validator with pct_oracle loaded (see oracle/README.md):
// config -> books -> sources -> submit the 5 fixture claims -> crank -> read the index back.
const rpc = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const fx = JSON.parse(readFileSync("oracle/programs/pct_oracle/tests/fixtures/claims.json", "utf8")) as Fixtures;
const connection = new Connection(rpc, "confirmed");
const payer = Keypair.generate();
await connection.confirmTransaction(await connection.requestAirdrop(payer.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");
const client = new OracleClient(connection, payer);

// Fixtures are signed at a fixed time, so widen staleness to keep this script valid on any day.
await client.upsertConfig([getBytes(fx.attestor)], { ...DEFAULT_INDEX_PARAMS, maxStalenessS: 10 * 365 * 86_400 });
await client.ensureBook(0, 0);
await client.ensureBook(0, 1);

for (const c of fx.claims) {
  const source = fixtureSource(c);
  await client.ensureSource(source);
  const r = await client.submitProof(fixtureProof(c, fx.attestor), source);
  console.log(`submit ${c.name.padEnd(15)} ${r.computeUnits} CU  expected $${c.expectedMicro / 1e6}/GPU-hr`);
}

try {
  await client.submitProof(fixtureProof(fx.claims[0]!, fx.attestor), fixtureSource(fx.claims[0]!));
  throw new Error("reused invoice was accepted");
} catch (err) {
  console.log(`resubmit lambda-invoice rejected: ${programError(err)}`);
}

for (const kind of [0, 1]) {
  const r = await client.crank(0, kind);
  const book = (await client.book(0, kind))!;
  const label = kind === 0 ? "paid" : "list";
  console.log(
    `crank H100 ${label}: ${r.computeUnits} CU  status=${book.status} value=$${Number(book.valueMicro) / 1e6} ` +
      `used=${book.used} rejected=${book.rejected} slots=${book.slots.map((s) => Number(s.priceMicro) / 1e6).join(",")}`,
  );
}
const paid = (await client.book(0, 0))!;
if (paid.status !== "live" || paid.valueMicro !== 2_490_000n) throw new Error("paid index does not match the TS reference ($2.49)");
console.log("e2e ok");
