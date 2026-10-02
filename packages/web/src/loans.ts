import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID, decodeLoan, discriminator, trailingCoverageBps, type LoanState } from "@pct/oracle";
import bs58 from "bs58";
import { parseDrawApproved, parseRevenueProven, type DrawApproved, type RevenueProven } from "./events.js";
import { providerName } from "./state.js";

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
  proofs: (RevenueProven & { provider: string; signature: string; slot: number })[];
  draws: (DrawApproved & { signature: string; slot: number; blockTime: number | null })[];
}

/** Same rule as Loan::covenant. */
export function covenantStatus(loan: LoanState, nowS: number): { status: CovenantStatus; coverageBps: number } {
  const latest = loan.history.at(-1);
  if (!latest) return { status: "no-recent-revenue", coverageBps: 0 };
  const coverageBps = Number(trailingCoverageBps(loan, latest.period));
  if (latest.period + 1 < Math.floor(nowS / loan.periodS)) return { status: "no-recent-revenue", coverageBps };
  return { status: coverageBps < loan.minCoverageBps ? "breached" : "ok", coverageBps };
}

async function activity(connection: Connection, loan: PublicKey) {
  const sigs = (await connection.getSignaturesForAddress(loan, { limit: 50 }, "confirmed")).filter((s) => s.err === null);
  const txs = await Promise.all(sigs.map((s) => connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })));
  const proofs: LoanView["proofs"] = [];
  const draws: LoanView["draws"] = [];
  txs.forEach((tx, i) => {
    const logs = tx?.meta?.logMessages ?? [];
    const { signature, slot, blockTime } = sigs[i]!;
    for (const p of parseRevenueProven(logs)) proofs.push({ ...p, provider: providerName(p.providerId), signature, slot });
    for (const d of parseDrawApproved(logs)) draws.push({ ...d, signature, slot, blockTime: blockTime ?? null });
  });
  return { proofs, draws };
}

/** Every Loan account of the program, newest activity first. */
export async function loadLoans(connection: Connection, programId: PublicKey = DEFAULT_PROGRAM_ID, limit = 5): Promise<LoanView[]> {
  const accounts = await connection.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(discriminator("account", "Loan")) } }],
  });
  const nowS = Math.floor(Date.now() / 1000);
  const decoded = accounts
    .map((a) => ({ a, loan: decodeLoan(a.account.data) }))
    .sort((x, y) => Number(y.loan.updatedAt - x.loan.updatedAt))
    .slice(0, limit);
  return Promise.all(
    decoded.map(async ({ a, loan }) => {
      const rentFloor = await connection.getMinimumBalanceForRentExemption(a.account.data.length);
      const { status, coverageBps } = covenantStatus(loan, nowS);
      const fleetHours = loan.fleetGpus * (loan.periodS / 3600);
      return {
        address: a.pubkey.toBase58(),
        lender: loan.lender.toBase58(),
        borrower: loan.borrower.toBase58(),
        operatorKey: "0x" + Buffer.from(loan.operatorKey).toString("hex"),
        fleetGpus: loan.fleetGpus,
        periodS: loan.periodS,
        debtServiceMicro: Number(loan.debtServiceMicro),
        minCoverageBps: loan.minCoverageBps,
        currency: loan.currency,
        drawnSol: Number(loan.drawnLamports) / LAMPORTS_PER_SOL,
        availableSol: Math.max(0, a.account.lamports - rentFloor) / LAMPORTS_PER_SOL,
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
        ...(await activity(connection, a.pubkey)),
      };
    }),
  );
}
