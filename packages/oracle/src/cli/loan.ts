import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getBytes, hexlify, keccak256, toUtf8Bytes, verifyMessage } from "ethers";
import { createSignDataForClaim, getAttestors } from "@reclaimprotocol/js-sdk";
import { REVENUE_SOURCES, assertRevenueProofMatches, type RevenueSourceSpec } from "@pct/prover";
import { accountOf, extractedOf, operatorKey, type ReclaimProof } from "../claim.js";
import { programError } from "../client.js";
import { clientFromEnv } from "../env.js";
import { DEFAULT_INDEX_PARAMS, trailingCoverageBps, type LoanState } from "../program.js";
import { revenueSourceArgs } from "../revenue.js";

// Lender flow from the command line, against SOLANA_RPC_URL with SOLANA_KEYPAIR (see oracle/README.md).
//   npm run loan:open   proofs/revenue/<proof>.json   register the source, open + fund a loan for that operator
//   npm run loan:submit proofs/revenue/<proof>.json   count a revenue proof toward the loan
//   npm run loan:draw   1                             borrower draws 1 SOL (refused if the covenant fails)
//   npm run loan:show
//   npm run loan:withdraw 1                         lender takes 1 SOL of undrawn funds back
// Terms come from env: LOAN_DEBT_SERVICE (per week, in the proof's currency; 1500), LOAN_MIN_COVERAGE (1.15),
// LOAN_COVENANT_WEEKS (13 = a quarter), LOAN_FLEET_GPUS (8), LOAN_FUND_SOL (1), LOAN_BORROWER (defaults to
// this wallet, so one wallet can demo both sides). The loan's currency is the first proof's (Razorpay: INR).
// The proof's signer must be a Reclaim attestor (Reclaim's live list, or PCT_ATTESTORS=0x..,0x..):
// a proof file is never trusted to say who its attestor is.
const STATE = join("proofs", "revenue", "loan.json");
const client = clientFromEnv();
const [cmd, arg] = process.argv.slice(2);

function readProof(file: string | undefined): { proof: ReclaimProof; spec: RevenueSourceSpec; account: string } {
  if (!file) throw new Error("pass a proof file, e.g. proofs/revenue/razorpay-payment-1790000000.json");
  const proof = JSON.parse(readFileSync(file, "utf8")) as ReclaimProof;
  const errors: string[] = [];
  for (const spec of REVENUE_SOURCES) {
    try {
      assertRevenueProofMatches(proof.claimData.parameters, spec);
      return { proof, spec, account: accountOf(proof) };
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  throw new Error(`${file} is not a proof of a known revenue source:\n  ${errors.join("\n  ")}`);
}

/** The address that signed the claim, recovered from the signature itself. */
function signerOf(proof: ReclaimProof): string {
  const c = proof.claimData;
  const data = createSignDataForClaim({ ...c, identifier: proof.identifier } as Parameters<typeof createSignDataForClaim>[0]);
  return verifyMessage(data, proof.signatures[0]!).toLowerCase();
}

async function trustedAttestors(): Promise<Set<string>> {
  const fromEnv = process.env.PCT_ATTESTORS?.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (fromEnv?.length) return new Set(fromEnv);
  return new Set((await getAttestors()).map((a) => a.id.toLowerCase()));
}

function savedLoan(): { operatorKey: Uint8Array; lender: PublicKey } {
  if (!existsSync(STATE)) throw new Error(`no ${STATE}; run npm run loan:open first`);
  const s = JSON.parse(readFileSync(STATE, "utf8")) as { operatorKey: string; lender: string };
  return { operatorKey: getBytes(s.operatorKey), lender: new PublicKey(s.lender) };
}

function describe(loan: LoanState): string {
  const latest = loan.history.at(-1);
  const lines = loan.history.map((p) => `  period ${p.period}: ${Number(p.revenueMicro) / 1e6} ${loan.currency} from ${p.proofs} proof(s), ${Number(p.gpuHoursMicro) / 1e6} GPU-h`);
  const cov = latest ? Number(trailingCoverageBps(loan, latest.period)) / 10_000 : 0;
  return [
    `debt service ${Number(loan.debtServiceMicro) / 1e6} ${loan.currency}/period, covenant ${loan.minCoverageBps / 10_000}x, drawn ${Number(loan.drawnLamports) / LAMPORTS_PER_SOL} SOL`,
    ...lines,
    `trailing coverage ${cov.toFixed(2)}x`,
  ].join("\n");
}

async function open(): Promise<void> {
  const { proof, spec, account } = readProof(arg);
  const signer = signerOf(proof);
  if (!(await trustedAttestors()).has(signer)) throw new Error(`proof is signed by ${signer}, which is not a Reclaim attestor`);
  const config = await client.config();
  if (!config?.attestors.includes(signer)) {
    const attestors = [...(config?.attestors ?? []), signer];
    await client.upsertConfig(attestors.map((a) => getBytes(a)), config?.params ?? DEFAULT_INDEX_PARAMS);
    console.log(`added attestor ${signer}`);
  }
  await client.ensureBook(0, 0);

  const args = revenueSourceArgs(spec, proof.claimData.parameters);
  const registered = await client.ensureSource(args);
  const existing = registered ? null : await client.connection.getAccountInfo(client.ix.pdas.source(args.sourceId));
  // PriceSource layout: discriminator, source_id, params_hash.
  if (existing && !Buffer.from(existing.data.subarray(40, 72)).equals(Buffer.from(args.paramsHash))) {
    throw new Error(`source ${spec.name} is already registered with different parameters; proofs of this shape will be refused`);
  }
  console.log(`${registered ? "registered" : "exists    "} source ${spec.name} -> ${client.ix.pdas.source(args.sourceId).toBase58()}`);

  const op = operatorKey(account);
  const env = (name: string, fallback: number) => Number(process.env[name]?.trim() || fallback);
  const borrower = process.env.LOAN_BORROWER?.trim() ? new PublicKey(process.env.LOAN_BORROWER.trim()) : client.payer.publicKey;
  const terms = {
    operatorKey: op,
    borrower,
    sku: 0,
    fleetGpus: env("LOAN_FLEET_GPUS", 8),
    periodS: 604_800,
    debtServiceMicro: BigInt(Math.round(env("LOAN_DEBT_SERVICE", 1500) * 1e6)),
    minCoverageBps: Math.round(env("LOAN_MIN_COVERAGE", 1.15) * 10_000),
    currency: (extractedOf(proof).currency ?? "USD").toUpperCase(),
    covenantPeriods: env("LOAN_COVENANT_WEEKS", 13),
  };
  await client.openLoan(terms, BigInt(Math.round(env("LOAN_FUND_SOL", 1) * LAMPORTS_PER_SOL)));
  mkdirSync(join("proofs", "revenue"), { recursive: true });
  const me = client.payer.publicKey;
  writeFileSync(STATE, JSON.stringify({ loan: client.ix.pdas.loan(me, op).toBase58(), lender: me.toBase58(), operatorKey: hexlify(op), account }, null, 2));
  console.log(`loan ${client.ix.pdas.loan(me, op).toBase58()} for operator ${keccak256(toUtf8Bytes(account)).slice(0, 10)}…, borrower ${borrower.toBase58()}`);
  console.log(describe((await client.loan(op))!));
}

async function submit(): Promise<void> {
  const { proof, spec, account } = readProof(arg);
  const op = operatorKey(account);
  const lender = existsSync(STATE) ? savedLoan().lender : client.payer.publicKey;
  try {
    const r = await client.submitRevenue(proof, revenueSourceArgs(spec, proof.claimData.parameters), op, lender);
    console.log(`ok ${spec.name} ${r.computeUnits ?? "?"} CU ${r.signature}`);
  } catch (err) {
    const why = programError(err);
    const hint = why.includes("OperatorMismatch") ? " (proof is for another operator)" : why.includes("StaleClaim") ? " (proof older than the config's staleness limit)" : "";
    throw new Error(`${why}${hint}`);
  }
  console.log(describe((await client.loan(op, lender))!));
}

async function draw(): Promise<void> {
  const { operatorKey: op, lender } = savedLoan();
  const sol = Number(arg ?? 1);
  try {
    const r = await client.draw(client.payer, op, BigInt(Math.round(sol * LAMPORTS_PER_SOL)), lender);
    console.log(`drew ${sol} SOL ${r.signature}`);
  } catch (err) {
    console.log(`draw refused: ${programError(err)}`);
  }
  console.log(describe((await client.loan(op, lender))!));
}

async function withdraw(): Promise<void> {
  const { operatorKey: op } = savedLoan();
  const sol = Number(arg ?? 1);
  console.log(`withdrew ${sol} SOL ${await client.withdraw(op, BigInt(Math.round(sol * LAMPORTS_PER_SOL)))}`);
}

async function show(): Promise<void> {
  const { operatorKey: op, lender } = savedLoan();
  const loan = await client.loan(op, lender);
  console.log(loan ? `loan ${client.ix.pdas.loan(lender, op).toBase58()}\n${describe(loan)}` : "loan not found on this cluster");
}

const commands: Record<string, () => Promise<void>> = { open, submit, draw, withdraw, show };
const run = commands[cmd ?? ""];
if (!run) throw new Error(`usage: loan.ts <${Object.keys(commands).join("|")}> [arg]`);
await run();
