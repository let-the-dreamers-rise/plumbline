import { readFileSync, writeFileSync } from "node:fs";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { getBytes, keccak256, toUtf8Bytes } from "ethers";
import { DEFAULT_INDEX_PARAMS, OracleClient, type SourceArgs } from "../packages/oracle/src/index.js";
import { clientFromEnv } from "../packages/oracle/src/env.js";

// Private covenant on a public chain: two real RISC Zero Groth16 proofs (NVIDIA's sample H100 report,
// VoltageGPU's public Intel TDX quote, a month of Razorpay revenue signed by two test attestors) are
// verified by pct_oracle. A loan at exactly 1.15x coverage goes PASS and its draw is approved; a loan
// at 1.14x goes WATCH and its draw is refused; replaying the PASS proof is refused. Every step lands
// on chain (failures too, sent without preflight) and its explorer link is written to zk-devnet-demo.json.
//
// Needs the program deployed and SOLANA_RPC_URL / SOLANA_KEYPAIR as for the other CLIs (~1 SOL spare).
const client = clientFromEnv();
const { connection, payer } = client;
const cluster = (process.env.SOLANA_RPC_URL ?? "").includes("devnet") || !process.env.SOLANA_RPC_URL ? "devnet" : "custom";
const link = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;

const fx = JSON.parse(readFileSync("zk/fixtures/revenue-claims.json", "utf8"));
const load = (label: string) => JSON.parse(readFileSync(`zk/fixtures/covenant-${label}-groth16.json`, "utf8"));
const pass = load("strong-pass115");
const watch = load("strong-watch114");
if (pass.imageId !== watch.imageId) throw new Error("the two proofs come from different guests");

const imageId = getBytes(pass.imageId);
const journal = (p: { journal: string }) => getBytes(p.journal);
const gpuNonce = journal(pass).slice(32, 64);
const operatorKey = getBytes(fx.terms.operator_key);
const attestors = (fx.attestors.attestors as string[]).map((a) => getBytes(a));
const asOf = fx.terms.as_of_period as number;
const periodNow = Math.floor(Date.now() / 1000 / fx.terms.period_s);
if (asOf + 1 < periodNow) throw new Error(`the proofs cover week ${asOf}; it is now week ${periodNow}, so they are too old to submit`);

const out: Record<string, unknown> = {
  programId: client.ix.programId.toBase58(),
  imageId: pass.imageId,
  gpuReport: "NVIDIA's published sample H100 report (public), chain verified to NVIDIA's root",
  tdxQuote: "VoltageGPU's published H200 Confidential VM quote (public), chain verified to Intel's root; not bound to the sample GPU report (vm_bound = 0)",
};

/** Sends without preflight so a refused step still lands on chain with its error; returns the signature and error. */
async function landed(signers: Keypair[], ...ixs: TransactionInstruction[]): Promise<{ sig: string; err: unknown; cu: number | null }> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await connection.confirmTransaction(sig, "confirmed");
  for (let i = 0; i < 20; i++) {
    const t = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (t) {
      const errLine = t.meta?.logMessages?.find((l) => l.includes("Error Code:"));
      return { sig, err: t.meta?.err ? (errLine ?? t.meta.err) : null, cu: t.meta?.computeUnitsConsumed ?? null };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`transaction ${sig} not found`);
}

// 1. Config: the two test attestors, the Razorpay revenue source the claims come from, the guest's image id.
await client.upsertConfig(attestors, DEFAULT_INDEX_PARAMS);
const source: SourceArgs = {
  sourceId: getBytes(keccak256(toUtf8Bytes("razorpay-zk"))),
  paramsHash: getBytes(fx.paramsHash),
  providerId: 7,
  sku: 0,
  kind: 2,
  gpuCount: 1,
  valueMode: 1,
  requiresNullifier: true,
};
await client.ensureSource(source);
out.zkConfig = link(await client.send(client.ix.setZkConfig(payer.publicKey, imageId, 2)));
// The product's price: every proof pays the treasury (default 0.0013 SOL, about $0.25), PASS or WATCH.
const fee = BigInt(process.env.PCT_PROOF_FEE_LAMPORTS ?? 1_300_000);
out.proofFee = { lamports: Number(fee), link: link(await client.send(client.ix.setProofFee(payer.publicKey, fee))) };
const treasury = client.ix.pdas.treasury();
const treasuryBefore = await connection.getBalance(treasury, "confirmed");

// 2. Two lenders lend to the same operator; the loans differ only in weekly debt service.
const borrower = Keypair.generate();
const fund = async (to: Keypair, sol: number) =>
  client.send(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to.publicKey, lamports: Math.round(sol * LAMPORTS_PER_SOL) }));
await fund(borrower, 0.01);

async function runLoan(name: string, debtServiceMicro: bigint, proof: { seal: string; journal: string }, replay: boolean) {
  const lender = Keypair.generate();
  await fund(lender, 0.12);
  const lc = new OracleClient(connection, lender, client.ix.programId);
  const terms = {
    operatorKey,
    borrower: borrower.publicKey,
    sku: 0,
    fleetGpus: 1,
    periodS: fx.terms.period_s,
    debtServiceMicro,
    minCoverageBps: fx.terms.min_coverage_bps,
    currency: fx.terms.currency,
    covenantPeriods: fx.terms.covenant_periods,
  };
  await lc.openLoan(terms, BigInt(0.05 * LAMPORTS_PER_SOL));
  await lc.send(lc.ix.issueGpuChallenge(lender.publicKey, operatorKey, gpuNonce));
  const loan = { lender: lender.publicKey, operatorKey };
  const budget = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  const prove = () => landed([payer], budget, client.ix.proveCovenant(payer.publicKey, source.sourceId, loan, getBytes(proof.seal), journal(proof), asOf));
  const p = await prove();
  const d = await landed([borrower], client.ix.drawPrivate(borrower.publicKey, loan, 0.01 * LAMPORTS_PER_SOL));
  const r = replay ? await prove() : null;
  out[name] = {
    loan: client.ix.pdas.loan(lender.publicKey, operatorKey).toBase58(),
    debtServiceInrPerWeek: Number(debtServiceMicro / 1_000_000n),
    proofVerified: { link: link(p.sig), computeUnits: p.cu, error: p.err },
    draw: { link: link(d.sig), approved: d.err === null, error: d.err },
    ...(r && { replay: { link: link(r.sig), rejected: r.err !== null, error: r.err } }),
  };
  console.log(name, JSON.stringify(out[name], null, 2));
}

await runLoan("loan115", 141_300_000_000n, pass, true);
await runLoan("loan114", 142_500_000_000n, watch, false);
out.treasury = { address: treasury.toBase58(), feesCollectedLamports: (await connection.getBalance(treasury, "confirmed")) - treasuryBefore };
writeFileSync("zk-devnet-demo.json", JSON.stringify(out, null, 2) + "\n");
console.log("wrote zk-devnet-demo.json");
