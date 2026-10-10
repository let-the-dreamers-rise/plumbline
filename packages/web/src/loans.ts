import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID, decodeLoan, discriminator, trailingCoverageBps, type LoanState } from "@pct/oracle";
import bs58 from "bs58";
import { parseDrawApproved, parseRevenueProven, type DrawApproved, type RevenueProven } from "./events.js";
import { providerName } from "./state.js";
import { loadZk, type ZkView } from "./zk.js";

export type CovenantStatus = "ok" | "breached" | "no-recent-revenue";

export interface PeriodView {
  period: number;
  startS: number;
  revenueMicro: number;
  gpuHoursMicro: number;
  proofs: number;
  /** GPU-hours sold over fleet GPU-hours in the period, 0..1; null when no source reported hours. */
  utilization: number | null;
}

export interface LoanView {
  address: string;
  lender: string;
  borrower: string;
  operatorKey: string;
  fleetGpus: number;
  periodS: number;
  debtServiceMicro: number;
  minCoverageBps: number;
  currency: string;
  drawnSol: number;
  availableSol: number;
  updatedAt: number;
  /** The covenant figure the draw instruction checks: trailing-quarter revenue / debt service. */
  trailingCoverageBps: number;
  status: CovenantStatus;
  periods: PeriodView[];
  /** Newest first, each with its transaction. */
  proofs: (RevenueProven & { provider: string; signature: string; slot: number; blockTime: number | null })[];
  draws: (DrawApproved & { signature: string; slot: number; blockTime: number | null })[];
  /** The private (zero-knowledge) covenant, when a challenge or proof exists for this loan. */
  zk: ZkView | null;
}

/** Same rule as Loan::covenant. */
export function covenantStatus(loan: LoanState, nowS: number): { status: CovenantStatus; coverageBps: number } {
  const latest = loan.history.at(-1);
  if (!latest) return { status: "no-recent-revenue", coverageBps: 0 };
  const coverageBps = Number(trailingCoverageBps(loan, latest.period));
  if (latest.period + 1 < Math.floor(nowS / loan.periodS)) return { status: "no-recent-revenue", coverageBps };
  return { status: coverageBps < loan.minCoverageBps ? "breached" : "ok", coverageBps };
}

async function activity(connection: Connection, loan: PublicKey, programId: PublicKey) {
  const sigs = (await connection.getSignaturesForAddress(loan, { limit: 50 }, "confirmed")).filter((s) => s.err === null);
  const txs = await Promise.all(sigs.map((s) => connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })));
  const proofs: LoanView["proofs"] = [];
  const draws: LoanView["draws"] = [];
  txs.forEach((tx, i) => {
    const logs = tx?.meta?.logMessages ?? [];
    const { signature, slot, blockTime } = sigs[i]!;
    // A transaction can touch several loans; only events about this one belong on its page.
    const id = loan.toBase58();
    for (const p of parseRevenueProven(logs, programId.toBase58())) if (p.loan === id) proofs.push({ ...p, provider: providerName(p.providerId), signature, slot, blockTime: blockTime ?? null });
    for (const d of parseDrawApproved(logs, programId.toBase58())) if (d.loan === id) draws.push({ ...d, signature, slot, blockTime: blockTime ?? null });
  });
  return { proofs, draws };
}

async function loanView(connection: Connection, programId: PublicKey, address: PublicKey, data: Buffer, lamports: number, nowS: number): Promise<LoanView> {
  const loan = decodeLoan(data);
  const rentFloor = await connection.getMinimumBalanceForRentExemption(data.length);
  const { status, coverageBps } = covenantStatus(loan, nowS);
  const fleetHours = loan.fleetGpus * (loan.periodS / 3600);
  const [act, zk] = await Promise.all([activity(connection, address, programId), loadZk(connection, programId, address)]);
  return {
    address: address.toBase58(),
    lender: loan.lender.toBase58(),
    borrower: loan.borrower.toBase58(),
    operatorKey: "0x" + Buffer.from(loan.operatorKey).toString("hex"),
    fleetGpus: loan.fleetGpus,
    periodS: loan.periodS,
    debtServiceMicro: Number(loan.debtServiceMicro),
    minCoverageBps: loan.minCoverageBps,
    currency: loan.currency,
    drawnSol: Number(loan.drawnLamports) / LAMPORTS_PER_SOL,
    availableSol: Math.max(0, lamports - rentFloor) / LAMPORTS_PER_SOL,
    updatedAt: Number(loan.updatedAt),
    trailingCoverageBps: coverageBps,
    status,
    periods: loan.history.map((p) => ({
      period: p.period,
      startS: p.period * loan.periodS,
      revenueMicro: Number(p.revenueMicro),
      gpuHoursMicro: Number(p.gpuHoursMicro),
      proofs: p.proofs,
      utilization: p.gpuHoursMicro > 0n ? Number(p.gpuHoursMicro) / 1e6 / fleetHours : null,
    })),
    ...act,
    zk,
  };
}

const LOAN_DISC = Buffer.from(discriminator("account", "Loan"));

/** Every Loan account of the program, newest activity first. */
export async function loadLoans(connection: Connection, programId: PublicKey = DEFAULT_PROGRAM_ID, limit = 5): Promise<LoanView[]> {
  const accounts = await connection.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(LOAN_DISC) } }],
  });
  const nowS = Math.floor(Date.now() / 1000);
  const newest = accounts
    .map((a) => ({ a, updatedAt: decodeLoan(a.account.data).updatedAt }))
    .sort((x, y) => Number(y.updatedAt - x.updatedAt))
    .slice(0, limit);
  return Promise.all(newest.map(({ a }) => loanView(connection, programId, a.pubkey, a.account.data, a.account.lamports, nowS)));
}

/** One Loan account by address; null when the address holds no loan of this program. */
export async function loadLoan(connection: Connection, programId: PublicKey, address: PublicKey): Promise<LoanView | null> {
  const a = await connection.getAccountInfo(address, "confirmed");
  if (!a || !a.owner.equals(programId) || !a.data.subarray(0, 8).equals(LOAN_DISC)) return null;
  return loanView(connection, programId, address, a.data, a.lamports, Math.floor(Date.now() / 1000));
}
