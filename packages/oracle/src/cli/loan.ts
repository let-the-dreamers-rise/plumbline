import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getBytes, hexlify, keccak256, toUtf8Bytes } from "ethers";
import { REVENUE_SOURCES, assertRevenueProofMatches, type RevenueSourceSpec } from "@pct/prover";
import { attestorsOf, extractedOf, operatorKey, type ReclaimProof } from "../claim.js";
import { programError } from "../client.js";
import { clientFromEnv } from "../env.js";
import { DEFAULT_INDEX_PARAMS, trailingCoverageBps, type LoanState } from "../program.js";
import { revenueSourceArgs } from "../revenue.js";

// Lender flow from the command line, against SOLANA_RPC_URL with SOLANA_KEYPAIR (see oracle/README.md).
//   npm run loan:open   proofs/revenue/<proof>.json   register the source, open + fund a loan for that operator
//   npm run loan:submit proofs/revenue/<proof>.json   count a revenue proof toward the loan
//   npm run loan:draw   1                             borrower draws 1 SOL (refused if the covenant fails)
//   npm run loan:show
// Terms come from env: LOAN_DEBT_SERVICE_USD (1500 per week), LOAN_MIN_COVERAGE (1.15), LOAN_FLEET_GPUS (8),
// LOAN_FUND_SOL (1), LOAN_BORROWER (defaults to this wallet, so one wallet can demo both sides).
const STATE = join("proofs", "revenue", "loan.json");
const client = clientFromEnv();
const [cmd, arg] = process.argv.slice(2);

function readProof(file: string | undefined): { proof: ReclaimProof; spec: RevenueSourceSpec; account: string } {
  if (!file) throw new Error("pass a proof file, e.g. proofs/revenue/stripe-payout-1790000000.json");
  const proof = JSON.parse(readFileSync(file, "utf8")) as ReclaimProof;
  const url = (JSON.parse(proof.claimData.parameters) as { url: string }).url;
  const spec = REVENUE_SOURCES.find((s) => s.url === url);
  if (!spec) throw new Error(`${file} is not a proof of a known revenue source (${url})`);
  assertRevenueProofMatches(proof.claimData.parameters, spec);
  const account = extractedOf(proof).account;
  if (!account) throw new Error(`${file} has no account in its extracted values`);
  return { proof, spec, account };
}

function savedLoan(): { operatorKey: Uint8Array; account: string } {
  if (!existsSync(STATE)) throw new Error(`no ${STATE}; run npm run loan:open first`);
  const s = JSON.parse(readFileSync(STATE, "utf8")) as { operatorKey: string; account: string };
  return { operatorKey: getBytes(s.operatorKey), account: s.account };
}

function describe(loan: LoanState): string {
  const latest = loan.history.at(-1);
  const lines = loan.history.map((p) => `  period ${p.period}: $${Number(p.revenueMicro) / 1e6} from ${p.proofs} proof(s), ${Number(p.gpuHoursMicro) / 1e6} GPU-h`);
  const cov = latest ? Number(trailingCoverageBps(loan, latest.period)) / 10_000 : 0;
  return [
    `debt service $${Number(loan.debtServiceMicro) / 1e6}/period, covenant ${loan.minCoverageBps / 10_000}x, drawn ${Number(loan.drawnLamports) / LAMPORTS_PER_SOL} SOL`,
    ...lines,
    `trailing coverage ${cov.toFixed(2)}x`,
  ].join("\n");
}

async function open(): Promise<void> {
  const { proof, spec, account } = readProof(arg);
  const config = await client.config();
  const attestors = new Set([...(config?.attestors ?? []), ...attestorsOf([proof]).map((a) => hexlify(a))]);
  await client.upsertConfig([...attestors].map((a) => getBytes(a)), config?.params ?? DEFAULT_INDEX_PARAMS);
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
    debtServiceMicro: BigInt(Math.round(env("LOAN_DEBT_SERVICE_USD", 1500) * 1e6)),
    minCoverageBps: Math.round(env("LOAN_MIN_COVERAGE", 1.15) * 10_000),
  };
  await client.openLoan(terms, BigInt(Math.round(env("LOAN_FUND_SOL", 1) * LAMPORTS_PER_SOL)));
  mkdirSync(join("proofs", "revenue"), { recursive: true });
  writeFileSync(STATE, JSON.stringify({ loan: client.ix.pdas.loan(op).toBase58(), operatorKey: hexlify(op), account }, null, 2));
  console.log(`loan ${client.ix.pdas.loan(op).toBase58()} for operator ${keccak256(toUtf8Bytes(account)).slice(0, 10)}…, borrower ${borrower.toBase58()}`);
  console.log(describe((await client.loan(op))!));
}

async function submit(): Promise<void> {
  const { proof, spec, account } = readProof(arg);
  const op = operatorKey(account);
  try {
    const r = await client.submitRevenue(proof, revenueSourceArgs(spec, proof.claimData.parameters).sourceId, op);
    console.log(`ok ${spec.name} ${r.computeUnits ?? "?"} CU ${r.signature}`);
  } catch (err) {
    const why = programError(err);
    const hint = why.includes("OperatorMismatch") ? " (proof is for another operator)" : why.includes("StaleClaim") ? " (proof older than the config's staleness limit)" : "";
    throw new Error(`${why}${hint}`);
  }
  console.log(describe((await client.loan(op))!));
}

async function draw(): Promise<void> {
  const { operatorKey: op } = savedLoan();
  const sol = Number(arg ?? 1);
  try {
    const r = await client.draw(client.payer, op, BigInt(Math.round(sol * LAMPORTS_PER_SOL)));
    console.log(`drew ${sol} SOL ${r.signature}`);
  } catch (err) {
    console.log(`draw refused: ${programError(err)}`);
  }
  console.log(describe((await client.loan(op))!));
}

async function show(): Promise<void> {
  const { operatorKey: op } = savedLoan();
  const loan = await client.loan(op);
  console.log(loan ? `loan ${client.ix.pdas.loan(op).toBase58()}\n${describe(loan)}` : "loan not found on this cluster");
}

const commands: Record<string, () => Promise<void>> = { open, submit, draw, show };
const run = commands[cmd ?? ""];
if (!run) throw new Error(`usage: loan.ts <${Object.keys(commands).join("|")}> [arg]`);
await run();
