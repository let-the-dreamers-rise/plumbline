/** Snapshot types. Every number a reader may want to check is a Sourced value. */
export interface Sourced<T = number | null> {
  readonly value: T;
  /** A tx or metadata URL, a price archive, or `derived: <formula>` naming the sourced inputs. */
  readonly source: string;
}

export interface LoanCollateralView {
  readonly tokenIds: readonly string[];
  readonly name: string;
  readonly models: readonly { readonly model: string | null; readonly label: string; readonly units: number; readonly gpus: number | null }[];
  readonly units: Sourced;
  readonly gpuCount: Sourced;
  readonly valueUsd: Sourced;
  readonly usefulLifeDays: Sourced;
  readonly metadataUrls: readonly string[];
}

export interface LoanEnrichmentView {
  readonly locationName: string | null;
  readonly offTakeCode: number | null;
  readonly dealStatus: string | null;
  readonly appAprPct: number | null;
  readonly source: string;
}

export interface LoanMetrics {
  readonly monthlyPaymentUsd: Sourced;
  readonly debtServicePerGpuHr: Sourced;
  readonly marketPerGpuHr: Sourced;
  readonly breakevenUtilization: Sourced;
  readonly coverageAtAssumedUtilization: Sourced;
  /** How far rents can fall, at the assumed utilization, before rent no longer covers debt service. */
  readonly rentDropToBreakeven: Sourced;
  readonly statedLtv: Sourced;
  readonly depreciatedLtv: Sourced;
}

export type RepaymentHealth = "current" | "behind" | "breached" | "liquidated" | "unknown";

export interface LoanView {
  readonly id: string;
  readonly hash: string;
  readonly router: string;
  readonly routerVersion: "v1" | "v2";
  readonly status: string;
  readonly borrower: Sourced<string | null>;
  readonly createdBy: string;
  readonly termsSource: string | null;
  readonly principalUsd: Sourced;
  readonly outstandingUsd: Sourced;
  readonly aprPct: Sourced;
  readonly termDays: Sourced;
  readonly originatedAt: Sourced<string | null>;
  readonly currentTermsAt: Sourced<string | null>;
  readonly maturityAt: Sourced<string | null>;
  readonly daysToMaturity: Sourced;
  readonly repayments: {
    readonly count: Sourced;
    readonly expectedApprox: Sourced;
    readonly lastPaidAt: Sourced<string | null>;
    readonly health: RepaymentHealth;
  };
  readonly collateral: LoanCollateralView | null;
  readonly enrichment: LoanEnrichmentView | null;
  readonly metrics: LoanMetrics;
  readonly flags: readonly string[];
  readonly links: { readonly createdTx: string; readonly originTx: string; readonly collateral: string | null };
}

export interface ClosedLoanView {
  readonly hash: string;
  readonly routerVersion: "v1" | "v2";
  readonly phase: string;
  readonly borrower: string | null;
  readonly principalUsd: Sourced;
  readonly successor: string | null;
  readonly note: string | null;
}

export interface Share {
  readonly key: string;
  readonly outstandingUsd: number;
  readonly share: number;
  readonly loans: number;
  readonly gpus?: number;
}

export interface BookSummary {
  readonly activeLoans: number;
  readonly principalUsd: Sourced;
  readonly outstandingUsd: Sourced;
  readonly collateralValueUsd: Sourced;
  readonly gpus: Sourced;
  readonly weightedAprPct: Sourced;
  readonly weightedBreakevenUtilization: Sourced;
  readonly monthlyDebtServiceUsd: Sourced;
  readonly topBorrower: Share | null;
  readonly byBorrower: readonly Share[];
  readonly byModel: readonly Share[];
  readonly byLocation: readonly Share[];
  readonly flagged: readonly { readonly id: string; readonly flags: readonly string[] }[];
  readonly closed: { readonly repaid: number; readonly liquidated: number; readonly supersededByRefinanceOrMigration: number; readonly excluded: number };
}

export interface Snapshot {
  readonly schema: "plumbline.monitor/v1";
  readonly generatedAt: string;
  readonly lender: "USD.AI";
  readonly chain: "arbitrum-one";
  readonly asOfBlock: number;
  readonly sources: {
    readonly rpc: string;
    readonly routers: readonly string[];
    readonly collateralNft: string;
    readonly metadata: string;
    readonly app: string;
    readonly prices: string;
  };
  readonly assumptions: Readonly<Record<string, number | string>>;
  readonly notes: readonly string[];
  readonly prices: Readonly<Record<string, { readonly medianUsdPerGpuHr: number | null; readonly sources: readonly { readonly source: string; readonly medianUsdPerGpuHr: number; readonly quotes: number }[] }>>;
  readonly book: BookSummary;
  readonly loans: readonly LoanView[];
  readonly closedLoans: readonly ClosedLoanView[];
  readonly unavailable: readonly string[];
}
