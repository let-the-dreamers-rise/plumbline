import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getBytes, hexlify, randomBytes } from "ethers";
import { DEFAULT_INDEX_PARAMS, OracleClient, operatorKey, programError, trailingCoverageBps } from "../packages/oracle/src/index.js";
import { localE2eAuthority } from "../packages/oracle/src/fixtures.js";
import { REVENUE_SOURCES, STRIPE_PAYOUT, TEST_ATTESTOR, VAST_HOST_PAYOUT, revenueSourceArgs, signTestRevenueClaim } from "../packages/oracle/src/revenue.js";

// Lender flow against a running validator with pct_oracle loaded (see oracle/README.md): a lender
// opens and funds a loan for a GPU operator; the operator's proven revenue unlocks a draw; a weak
// week breaches the 1.15x covenant and the next draw is refused. Claims are signed fresh by the
// TEST attestor, dated last week and this week, so this works on any day.
const rpc = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const connection = new Connection(rpc, "confirmed");
const lender = localE2eAuthority();
const borrower = Keypair.generate();
for (const k of [lender, borrower]) {
  await connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, 20 * LAMPORTS_PER_SOL), "confirmed");
}
const client = new OracleClient(connection, lender);
// DEMO_PAUSE_MS spaces out the steps so a dashboard recording shows each one land.
const pauseMs = Number(process.env.DEMO_PAUSE_MS ?? 0);
const pause = () => new Promise((r) => setTimeout(r, pauseMs));

const PERIOD_S = 604_800;
const now = Math.floor(Date.now() / 1000) - 30;
const thisWeek = Math.floor(now / PERIOD_S) * PERIOD_S;
const lastWeek = thisWeek - PERIOD_S;

await client.upsertConfig([getBytes(TEST_ATTESTOR.address)], { ...DEFAULT_INDEX_PARAMS, maxStalenessS: 30 * 86_400 });
await client.ensureBook(0, 0);
for (const s of REVENUE_SOURCES) await client.ensureSource(revenueSourceArgs(s));

// A fresh operator each run: its account id as the proofs reveal it.
const account = hexlify(randomBytes(32));
const op = operatorKey(account);
await client.openLoan(
  { operatorKey: op, borrower: borrower.publicKey, sku: 0, fleetGpus: 8, periodS: PERIOD_S, debtServiceMicro: 1_500_000_000n, minCoverageBps: 11_500, currency: "USD" },
  BigInt(10 * LAMPORTS_PER_SOL),
);
console.log(`loan ${client.ix.pdas.loan(op).toBase58()}: 8x H100, $1,500/week debt service, 1.15x covenant, funded 10 SOL`);

const tryDraw = async (label: string, sol: number) => {
  await pause();
  try {
    const r = await client.draw(borrower, op, BigInt(sol * LAMPORTS_PER_SOL));
    console.log(`draw ${sol} SOL ${label}: approved (${r.computeUnits} CU)`);
    return true;
  } catch (err) {
    console.log(`draw ${sol} SOL ${label}: refused, ${programError(err)}`);
    return false;
  }
};
const submit = async (label: string, proof: Awaited<ReturnType<typeof signTestRevenueClaim>>, source = VAST_HOST_PAYOUT) => {
  await pause();
  const r = await client.submitRevenue(proof, revenueSourceArgs(source).sourceId, op);
  const loan = (await client.loan(op))!;
  const latest = loan.history.at(-1)!;
  console.log(`proof ${label.padEnd(26)} ${r.computeUnits} CU  trailing coverage ${Number(trailingCoverageBps(loan, latest.period)) / 10_000}x`);
};

if (await tryDraw("before any proof", 1)) throw new Error("draw allowed without revenue");

const payoutId = `po_${hexlify(randomBytes(8)).slice(2)}`;
await submit("vast last week $2,580.48", await signTestRevenueClaim(VAST_HOST_PAYOUT, { account, amount: "2580.48", hours: "1075.2" }, lastWeek + 3_600));
const stripe = await signTestRevenueClaim(STRIPE_PAYOUT, { account, amount_cents: "40000", at: String(lastWeek + 7_200), item: payoutId }, lastWeek + 9_000);
await submit("stripe payout last week $400", stripe, STRIPE_PAYOUT);
if (!(await tryDraw("after last week's proofs", 2))) throw new Error("covenant should hold at 1.99x");

try {
  await client.submitRevenue(stripe, revenueSourceArgs(STRIPE_PAYOUT).sourceId, op);
  throw new Error("payout counted twice");
} catch (err) {
  console.log(`same payout again: rejected, ${programError(err)}`);
}

await submit("vast this week $360", await signTestRevenueClaim(VAST_HOST_PAYOUT, { account, amount: "360", hours: "150" }, Math.max(thisWeek + 60, now - 60)));
if (await tryDraw("after a weak week", 1)) throw new Error("draw allowed under 1.15x");

const loan = (await client.loan(op))!;
const book = (await client.book(0, 0))!;
console.log(
  `loan history: ${loan.history.map((p) => `period ${p.period} $${Number(p.revenueMicro) / 1e6} ${Number(p.gpuHoursMicro) / 1e6} GPU-h`).join("; ")}; drawn ${Number(loan.drawnLamports) / LAMPORTS_PER_SOL} SOL`,
);
console.log(`paid H100 tape now holds ${book.len} slot(s), last $${Number(book.slots.at(-1)!.priceMicro) / 1e6}/GPU-hr`);
console.log("lending e2e ok");
