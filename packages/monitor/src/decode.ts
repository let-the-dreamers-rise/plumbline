import { AbiCoder, Interface, id } from "ethers";
import { MIN_MATERIAL_TRANCHE, SECONDS_PER_YEAR, WAD } from "./constants.js";

/**
 * Decoding for USD.AI's LoanRouter (v1) and LoanRouterV2 logs, view calls and calldata. Interfaces from
 * github.com/usdai-foundation/usdai-loan-router-contracts (src/interfaces/ILoanRouterV2.sol, and
 * ILoanRouter.sol before it was removed). Every decoder is pure and throws only on malformed input.
 */
export interface RawLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: string;
  readonly transactionHash: string;
  readonly logIndex: string;
  readonly blockTimestamp?: string;
}

export interface Tranche {
  readonly lender: string;
  readonly amount: bigint;
  /** Per-second simple rate, 1e18 fixed point. */
  readonly ratePerSecond: bigint;
}

export interface FeeTerm {
  /** 0 origination, 1 repayment, 2 exit, 3 liquidation, 4 refinance. */
  readonly kind: number;
  readonly model: string;
  readonly options: string;
}

/** Loan terms normalized across router versions. */
export interface LoanTerms {
  readonly borrower: string;
  readonly currencyToken: string;
  readonly collateralToken: string;
  readonly collateralTokenIds: readonly string[];
  readonly termDays: number;
  readonly rateModel: string;
  /** Seconds between scheduled repayments, when the terms state it. */
  readonly repaymentIntervalS: number | null;
  readonly tranches: readonly Tranche[];
  readonly fees: readonly FeeTerm[];
}

export interface LogMeta {
  readonly router: string;
  readonly block: number;
  readonly tx: string;
  readonly logIndex: number;
  readonly timestamp: number | null;
}

export type RouterEvent = LogMeta &
  (
    | { readonly kind: "originated"; readonly hash: string; readonly terms: LoanTerms | null; readonly borrower: string | null; readonly principal: bigint | null }
    | { readonly kind: "migrated"; readonly hash: string; readonly oldHash: string; readonly terms: LoanTerms }
    | { readonly kind: "migratedOut"; readonly hash: string }
    | { readonly kind: "refinanced"; readonly hash: string; readonly oldHash: string; readonly terms: LoanTerms }
    | {
        readonly kind: "repaid";
        readonly hash: string;
        readonly borrower: string;
        readonly principal: bigint;
        readonly interest: bigint;
        readonly prepayment: bigint;
        readonly fee: bigint;
        readonly isRepaid: boolean;
      }
    | { readonly kind: "breached"; readonly hash: string }
    | { readonly kind: "liquidated"; readonly hash: string }
  );

const TERMS_V2 =
  "tuple(uint64 expiration,address borrower,address currencyToken,address collateralToken," +
  "tuple(uint16 totalDurationDays,uint8 day,int32 timezoneOffsetSeconds) repaymentSpec," +
  "tuple(address model,bytes options) interestRateSpec,uint256[] collateralTokenIds," +
  "tuple(address lender,uint256 amount,uint256 rate)[] trancheSpecs," +
  "tuple(uint8 kind,address recipient,address model,bytes options)[] feeSpecs,address[] approvalAddresses,bytes options)";

const TERMS_V1 =
  "tuple(uint64 expiration,address borrower,address currencyToken,address collateralToken,uint256 collateralTokenId," +
  "uint64 duration,uint64 repaymentInterval,address interestRateModel,uint256 gracePeriodRate,uint256 gracePeriodDuration," +
  "tuple(uint256 originationFee,uint256 exitFee) feeSpec,tuple(address lender,uint256 amount,uint256 rate)[] trancheSpecs," +
  "bytes collateralWrapperContext,bytes options)";

export const TOPICS = {
  /** v1, and LoanRouterV2 before v1.2: terms are not in the event. */
  originatedLegacy: id("LoanOriginated(bytes32,address,address,uint256,uint256)"),
  /** LoanRouterV2 v1.2+: the full ABI-encoded LoanTermsV2. */
  originated: id("LoanOriginated(bytes32,bytes)"),
  migrated: id("LoanMigrated(bytes32,bytes32,bytes)"),
  /** Emitted by the v1 router when a loan moves to V2; not in the published v1 interface, identified by matching every LoanMigrated. */
  migratedOut: "0x1fcb138c59f732a031845f8c0a80474a91435339c74b73c730346aeac2d86e68",
  refinancedV11: id("LoanRefinanced(bytes32,bytes32,bytes)"),
  refinanced: id("LoanRefinanced(bytes32,bytes32,bytes,uint256,uint256,uint256)"),
  repaid: id("LoanRepaid(bytes32,address,uint256,uint256,uint256,uint256,bool)"),
  breached: id("LoanBreached(bytes32)"),
  liquidated: id("LoanLiquidated(bytes32)"),
} as const;

const coder = AbiCoder.defaultAbiCoder();
const lower = (a: string) => a.toLowerCase();
const topicAddress = (t: string) => lower("0x" + t.slice(-40));

export const routerInterface = new Interface([
  "function loanState(bytes32) view returns (uint8 status, uint16 repaymentCount, uint64 originationTimestamp, uint256 scaledBalance)",
  "function tokenURI(uint256) view returns (string)",
  `function borrow(${TERMS_V1} loanTerms, tuple(uint8 depositType,bytes data)[] lenderDepositInfos)`,
]);

/** Second word of the amortized/simple model options is the repayment interval in seconds. */
function intervalFromOptions(options: string): number | null {
  try {
    const words = coder.decode(["uint256", "uint256", "uint256"], options);
    const s = Number(words[1]);
    return s > 0 && s < 400 * 86_400 ? s : null;
  } catch {
    return null;
  }
}

const tranchesOf = (rows: any[]): Tranche[] =>
  rows.map((t) => ({ lender: lower(t.lender), amount: BigInt(t.amount), ratePerSecond: BigInt(t.rate) }));

/** Decodes ABI-encoded LoanTermsV2 bytes (as carried by LoanOriginated v1.2+, LoanMigrated and LoanRefinanced). */
export function decodeTermsV2(encoded: string): LoanTerms {
  const t: any = coder.decode([TERMS_V2], encoded)[0];
  return {
    borrower: lower(t.borrower),
    currencyToken: lower(t.currencyToken),
    collateralToken: lower(t.collateralToken),
    collateralTokenIds: [...t.collateralTokenIds].map((x: bigint) => x.toString()),
    termDays: Number(t.repaymentSpec.totalDurationDays),
    rateModel: lower(t.interestRateSpec.model),
    repaymentIntervalS: intervalFromOptions(t.interestRateSpec.options),
    tranches: tranchesOf([...t.trancheSpecs]),
    fees: [...t.feeSpecs].map((f: any) => ({ kind: Number(f.kind), model: lower(f.model), options: f.options })),
  };
}

/**
 * Finds a v1 `borrow(...)` call inside a transaction's input and decodes its terms. Older loans were
 * originated through ERC-4337 smart accounts, so the call sits inside handleOps/execute calldata; ABI
 * offsets are relative to the inner call, so slicing at its selector decodes it. Null when not found.
 */
export function decodeV1BorrowCalldata(input: string): LoanTerms | null {
  const selector = routerInterface.getFunction("borrow")!.selector.slice(2);
  const hex = input.toLowerCase().replace(/^0x/, "");
  for (let at = hex.indexOf(selector); at >= 0; at = hex.indexOf(selector, at + 2)) {
    if (at % 2 !== 0) continue;
    try {
      const t: any = routerInterface.decodeFunctionData("borrow", "0x" + hex.slice(at))[0];
      return {
        borrower: lower(t.borrower),
        currencyToken: lower(t.currencyToken),
        collateralToken: lower(t.collateralToken),
        collateralTokenIds: [t.collateralTokenId.toString()],
        termDays: Number(t.duration) / 86_400,
        rateModel: lower(t.interestRateModel),
        repaymentIntervalS: Number(t.repaymentInterval) || null,
        tranches: tranchesOf([...t.trancheSpecs]),
        fees: [],
      };
    } catch {
      // Not this occurrence; keep scanning.
    }
  }
  return null;
}

function metaOf(log: RawLog): LogMeta {
  return {
    router: lower(log.address),
    block: Number(BigInt(log.blockNumber)),
    tx: lower(log.transactionHash),
    logIndex: Number(BigInt(log.logIndex)),
    // arb1.arbitrum.io returns blockTimestamp "0x0" for older logs: treat zero as unknown.
    timestamp: log.blockTimestamp && BigInt(log.blockTimestamp) > 0n ? Number(BigInt(log.blockTimestamp)) : null,
  };
}

/** Decodes one router log, or returns null for events the monitor does not use (transfers, roles, fees). */
export function decodeLog(log: RawLog): RouterEvent | null {
  const [topic0, t1, t2] = log.topics.map(lower);
  const meta = metaOf(log);
  switch (topic0) {
    case TOPICS.originated: {
      const [bytes] = coder.decode(["bytes"], log.data);
      const terms = decodeTermsV2(bytes);
      return { ...meta, kind: "originated", hash: t1!, terms, borrower: terms.borrower, principal: null };
    }
    case TOPICS.originatedLegacy: {
      const [principal] = coder.decode(["uint256", "uint256"], log.data);
      return { ...meta, kind: "originated", hash: t1!, terms: null, borrower: topicAddress(log.topics[2]!), principal: BigInt(principal) };
    }
    case TOPICS.migrated:
      return { ...meta, kind: "migrated", oldHash: t1!, hash: t2!, terms: decodeTermsV2(coder.decode(["bytes"], log.data)[0]) };
    case TOPICS.migratedOut:
      return { ...meta, kind: "migratedOut", hash: t1! };
    case TOPICS.refinanced:
    case TOPICS.refinancedV11: {
      const [bytes] = coder.decode(["bytes"], log.data);
      return { ...meta, kind: "refinanced", oldHash: t1!, hash: t2!, terms: decodeTermsV2(bytes) };
    }
    case TOPICS.repaid: {
      const [principal, interest, prepayment, fee, isRepaid] = coder.decode(["uint256", "uint256", "uint256", "uint256", "bool"], log.data);
      return {
        ...meta,
        kind: "repaid",
        hash: t1!,
        borrower: topicAddress(log.topics[2]!),
        principal: BigInt(principal),
        interest: BigInt(interest),
        prepayment: BigInt(prepayment),
        fee: BigInt(fee),
        isRepaid: Boolean(isRepaid),
      };
    }
    case TOPICS.breached:
      return { ...meta, kind: "breached", hash: t1! };
    case TOPICS.liquidated:
      return { ...meta, kind: "liquidated", hash: t1! };
    default:
      return null;
  }
}

export const LOAN_STATUS = ["Uninitialized", "Active", "Repaid", "Breached", "Liquidated", "CollateralLiquidated"] as const;
export type LoanStatusName = (typeof LOAN_STATUS)[number] | "Unknown";

export interface LoanState {
  readonly status: LoanStatusName;
  readonly repaymentCount: number;
  readonly originationTimestamp: number;
  readonly scaledBalance: bigint;
}

/** Decodes LoanRouterV2 `loanState(bytes32)` return data. */
export function decodeLoanState(data: string): LoanState {
  const r = routerInterface.decodeFunctionResult("loanState", data);
  return {
    status: LOAN_STATUS[Number(r[0])] ?? "Unknown",
    repaymentCount: Number(r[1]),
    originationTimestamp: Number(r[2]),
    scaledBalance: BigInt(r[3]),
  };
}

/** Tranches that carry real principal (placeholder tranches of 1 wei to 1 USDai are left out). */
export const materialTranches = (terms: LoanTerms): readonly Tranche[] => terms.tranches.filter((t) => t.amount >= MIN_MATERIAL_TRANCHE);

/** Principal of the loan as originated or refinanced: the sum of material tranches, in token units. */
export function principalOf(terms: LoanTerms): bigint {
  return materialTranches(terms).reduce((s, t) => s + t.amount, 0n);
}

/** Principal-weighted lender APR over material tranches, as a fraction (0.085 = 8.5%). */
export function aprOf(terms: LoanTerms): number | null {
  const ts = materialTranches(terms);
  const total = ts.reduce((s, t) => s + t.amount, 0n);
  if (total === 0n) return null;
  const weighted = ts.reduce((s, t) => s + t.amount * t.ratePerSecond, 0n) / total;
  return (Number(weighted) * SECONDS_PER_YEAR) / Number(WAD);
}

/** Token units (18 decimals) to a float in whole tokens. */
export const tokens = (v: bigint): number => Number(v / 10n ** 12n) / 1e6;
