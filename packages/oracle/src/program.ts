import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { getBytes, keccak256 } from "ethers";
import { Reader, Writer, discriminator } from "./borsh.js";

/** Matches declare_id! in oracle/programs/pct_oracle/src/lib.rs. Override with PCT_PROGRAM_ID for other deploys. */
export const DEFAULT_PROGRAM_ID = new PublicKey("2jvEsAiBYWPeiSzb54qMgBbtbQivQkK5ZiTkp2bgZ6kz");

export const SKU_IDS = { H100: 0, H200: 1, B200: 2 } as const;
export const KIND_IDS = { paid: 0, list: 1, revenue: 2 } as const;
/** Periods of revenue history a Loan keeps (LOAN_HISTORY in constants.rs). */
export const LOAN_HISTORY = 13;
export const VALUE_MODE_RATE = 0;
export const VALUE_MODE_AMOUNT_HOURS = 1;
/** Bytes per write_buffer call; keeps each transaction well under the 1232-byte limit. */
export const WRITE_CHUNK = 800;

/** Onchain IndexParams. Mirrors packages/core DEFAULT_PARAMS in integer units. */
export interface IndexParams {
  maxStalenessS: number;
  maxFutureSkewS: number;
  minProviders: number;
  providerCapBps: number;
  madKMilli: number;
  madFloorBps: number;
}

export const DEFAULT_INDEX_PARAMS: IndexParams = {
  maxStalenessS: 86_400,
  maxFutureSkewS: 300,
  minProviders: 3,
  providerCapBps: 2_500,
  madKMilli: 3_000,
  madFloorBps: 50,
};

export interface SourceArgs {
  sourceId: Uint8Array;
  paramsHash: Uint8Array;
  providerId: number;
  sku: number;
  kind: number;
  gpuCount: number;
  valueMode: number;
  requiresNullifier: boolean;
}

export interface ClaimSig {
  owner: string;
  timestampS: number;
  epoch: number;
  signature: Uint8Array;
}

export class OraclePdas {
  constructor(readonly programId: PublicKey = DEFAULT_PROGRAM_ID) {}

  private find(...seeds: Uint8Array[]): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, this.programId)[0];
  }
  config(): PublicKey {
    return this.find(Buffer.from("config"));
  }
  source(sourceId: Uint8Array): PublicKey {
    return this.find(Buffer.from("source"), sourceId);
  }
  book(sku: number, kind: number): PublicKey {
    return this.find(Buffer.from("book"), Uint8Array.of(sku), Uint8Array.of(kind));
  }
  buffer(authority: PublicKey): PublicKey {
    return this.find(Buffer.from("buffer"), authority.toBytes());
  }
  receipt(source: PublicKey, receiptKey: Uint8Array): PublicKey {
    return this.find(Buffer.from("receipt"), source.toBytes(), receiptKey);
  }
  loan(operatorKey: Uint8Array): PublicKey {
    return this.find(Buffer.from("loan"), operatorKey);
  }
}

/** Mirrors LoanTerms in instructions/lending.rs. */
export interface LoanTerms {
  /** keccak of the operator's account id as its revenue proofs reveal it (see operatorKey()). */
  operatorKey: Uint8Array;
  borrower: PublicKey;
  sku: number;
  fleetGpus: number;
  periodS: number;
  debtServiceMicro: bigint;
  minCoverageBps: number;
  /** ISO 4217 code, e.g. "USD" or "INR"; proofs carrying another currency are refused. */
  currency: string;
}

const signer = (pubkey: PublicKey, isWritable = true): AccountMeta => ({ pubkey, isSigner: true, isWritable });
const writable = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const readonly = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const system = readonly(SystemProgram.programId);

function writeParams(w: Writer, p: IndexParams): Writer {
  return w.i64(p.maxStalenessS).i64(p.maxFutureSkewS).u8(p.minProviders).u16(p.providerCapBps).u32(p.madKMilli).u16(p.madFloorBps);
}

function attestorVec(w: Writer, attestors: readonly Uint8Array[]): Writer {
  w.u32(attestors.length);
  attestors.forEach((a) => w.fixed(a, 20));
  return w;
}

/** Builds pct_oracle instructions (Anchor wire format, accounts in #[derive(Accounts)] order). */
export class OracleInstructions {
  readonly pdas: OraclePdas;

  constructor(readonly programId: PublicKey = DEFAULT_PROGRAM_ID) {
    this.pdas = new OraclePdas(programId);
  }

  private ix(name: string, keys: AccountMeta[], args: Writer = new Writer()): TransactionInstruction {
    const data = Buffer.concat([discriminator("global", name), args.bytes()]);
    return new TransactionInstruction({ programId: this.programId, keys, data });
  }

  initializeConfig(authority: PublicKey, attestors: readonly Uint8Array[], params: IndexParams): TransactionInstruction {
    const args = writeParams(attestorVec(new Writer(), attestors), params);
    return this.ix("initialize_config", [signer(authority), writable(this.pdas.config()), system], args);
  }

  updateConfig(authority: PublicKey, attestors: readonly Uint8Array[], params: IndexParams): TransactionInstruction {
    const args = writeParams(attestorVec(new Writer(), attestors), params);
    return this.ix("update_config", [signer(authority, false), writable(this.pdas.config())], args);
  }

  registerSource(authority: PublicKey, a: SourceArgs): TransactionInstruction {
    const args = new Writer()
      .fixed(a.sourceId, 32)
      .fixed(a.paramsHash, 32)
      .u16(a.providerId)
      .u8(a.sku)
      .u8(a.kind)
      .u16(a.gpuCount)
      .u8(a.valueMode)
      .bool(a.requiresNullifier);
    const keys = [signer(authority), readonly(this.pdas.config()), writable(this.pdas.source(a.sourceId)), system];
    return this.ix("register_source", keys, args);
  }

  setSourceActive(authority: PublicKey, sourceId: Uint8Array, active: boolean): TransactionInstruction {
    const keys = [signer(authority, false), readonly(this.pdas.config()), writable(this.pdas.source(sourceId))];
    return this.ix("set_source_active", keys, new Writer().bool(active));
  }

  initBook(payer: PublicKey, sku: number, kind: number): TransactionInstruction {
    const keys = [signer(payer), writable(this.pdas.book(sku, kind)), system];
    return this.ix("init_book", keys, new Writer().u8(sku).u8(kind));
  }

  openBuffer(authority: PublicKey, providerLen: number, parametersLen: number, contextLen: number): TransactionInstruction {
    const keys = [signer(authority), writable(this.pdas.buffer(authority)), system];
    return this.ix("open_buffer", keys, new Writer().u16(providerLen).u16(parametersLen).u16(contextLen));
  }

  writeBuffer(authority: PublicKey, offset: number, bytes: Uint8Array): TransactionInstruction {
    const keys = [signer(authority, false), writable(this.pdas.buffer(authority))];
    return this.ix("write_buffer", keys, new Writer().u16(offset).vec(bytes));
  }

  closeBuffer(authority: PublicKey): TransactionInstruction {
    return this.ix("close_buffer", [signer(authority), writable(this.pdas.buffer(authority))]);
  }

  submitObservation(
    submitter: PublicKey,
    source: { sourceId: Uint8Array; sku: number; kind: number },
    sig: ClaimSig,
    receiptKey: Uint8Array,
  ): TransactionInstruction {
    const sourcePda = this.pdas.source(source.sourceId);
    const keys = [
      signer(submitter),
      readonly(this.pdas.config()),
      readonly(sourcePda),
      writable(this.pdas.book(source.sku, source.kind)),
      writable(this.pdas.buffer(submitter)),
      writable(this.pdas.receipt(sourcePda, receiptKey)),
      system,
    ];
    const args = new Writer().string(sig.owner).u32(sig.timestampS).u32(sig.epoch).fixed(sig.signature, 65).fixed(receiptKey, 32);
    return this.ix("submit_observation", keys, args);
  }

  openLoan(lender: PublicKey, t: LoanTerms): TransactionInstruction {
    const args = new Writer()
      .fixed(t.operatorKey, 32)
      .pubkey(t.borrower)
      .u8(t.sku)
      .u16(t.fleetGpus)
      .u32(t.periodS)
      .u64(t.debtServiceMicro)
      .u16(t.minCoverageBps)
      .fixed(currencyBytes(t.currency), 3);
    return this.ix("open_loan", [signer(lender), writable(this.pdas.loan(t.operatorKey)), system], args);
  }

  fundLoan(lender: PublicKey, operatorKey: Uint8Array, lamports: bigint | number): TransactionInstruction {
    return this.ix("fund_loan", [signer(lender), writable(this.pdas.loan(operatorKey)), system], new Writer().u64(lamports));
  }

  /** `receiptKey` comes from revenueReceiptKeyFor (claim.ts): per payout item, else per loan period. */
  submitRevenue(
    submitter: PublicKey,
    sourceId: Uint8Array,
    loan: { operatorKey: Uint8Array; sku: number },
    sig: ClaimSig,
    receiptKey: Uint8Array,
  ): TransactionInstruction {
    const sourcePda = this.pdas.source(sourceId);
    const keys = [
      signer(submitter),
      readonly(this.pdas.config()),
      readonly(sourcePda),
      writable(this.pdas.loan(loan.operatorKey)),
      writable(this.pdas.book(loan.sku, KIND_IDS.paid)),
      writable(this.pdas.buffer(submitter)),
      writable(this.pdas.receipt(sourcePda, receiptKey)),
      system,
    ];
    const args = new Writer().string(sig.owner).u32(sig.timestampS).u32(sig.epoch).fixed(sig.signature, 65).fixed(receiptKey, 32);
    return this.ix("submit_revenue", keys, args);
  }

  draw(borrower: PublicKey, operatorKey: Uint8Array, lamports: bigint | number): TransactionInstruction {
    return this.ix("draw", [signer(borrower), writable(this.pdas.loan(operatorKey))], new Writer().u64(lamports));
  }

  crankIndex(sku: number, kind: number): TransactionInstruction {
    return this.ix("crank_index", [readonly(this.pdas.config()), writable(this.pdas.book(sku, kind))]);
  }
}

export function currencyBytes(code: string): Uint8Array {
  if (!/^[A-Z]{3}$/.test(code)) throw new Error(`currency must be a 3-letter ISO code, got "${code}"`);
  return Buffer.from(code, "ascii");
}

/** Same as revenue_receipt_key in lending.rs: keccak(operator_key || period as u32 LE). */
export function revenueReceiptKey(operatorKey: Uint8Array, period: number): Uint8Array {
  const bytes = new Uint8Array(36);
  bytes.set(operatorKey, 0);
  new DataView(bytes.buffer).setUint32(32, period, true);
  return getBytes(keccak256(bytes));
}

/** Same as revenue_item_key in lending.rs: keccak("item:" || operator_key || item). */
export function revenueItemKey(operatorKey: Uint8Array, item: string): Uint8Array {
  return getBytes(keccak256(new Uint8Array([...Buffer.from("item:"), ...operatorKey, ...Buffer.from(item, "utf8")])));
}

export interface BookSlot {
  providerId: number;
  priceMicro: bigint;
  observedAt: bigint;
  weight: number;
}

export interface BookState {
  sku: number;
  kind: number;
  len: number;
  slots: BookSlot[];
  valueMicro: bigint;
  status: "never" | "live" | "frozen";
  used: number;
  rejected: number;
  updatedAt: bigint;
}

const BOOK_CAPACITY = 32;
const STATUS = ["never", "live", "frozen"] as const;

export function decodeBook(data: Uint8Array): BookState {
  const r = new Reader(data);
  const disc = r.take(8);
  if (!Buffer.from(disc).equals(Buffer.from(discriminator("account", "Book")))) throw new Error("not a Book account");
  const sku = r.u8();
  const kind = r.u8();
  r.u8(); // next
  const len = r.u8();
  const slots: BookSlot[] = [];
  for (let i = 0; i < BOOK_CAPACITY; i++) {
    slots.push({ providerId: r.u16(), priceMicro: r.u64(), observedAt: r.i64(), weight: r.u32() });
  }
  const valueMicro = r.u64();
  const status = STATUS[r.u8()] ?? "never";
  return { sku, kind, len, slots: slots.slice(0, len), valueMicro, status, used: r.u8(), rejected: r.u8(), updatedAt: r.i64() };
}

export interface ConfigState {
  authority: PublicKey;
  attestors: string[];
  params: IndexParams;
}

export function decodeConfig(data: Uint8Array): ConfigState {
  const r = new Reader(data);
  if (!Buffer.from(r.take(8)).equals(Buffer.from(discriminator("account", "Config")))) throw new Error("not a Config account");
  const authority = new PublicKey(r.take(32));
  const n = r.u32();
  const attestors = Array.from({ length: n }, () => "0x" + Buffer.from(r.take(20)).toString("hex"));
  const params: IndexParams = {
    maxStalenessS: Number(r.i64()),
    maxFutureSkewS: Number(r.i64()),
    minProviders: r.u8(),
    providerCapBps: r.u16(),
    madKMilli: r.u32(),
    madFloorBps: r.u16(),
  };
  return { authority, attestors, params };
}

export interface PeriodRevenue {
  period: number;
  revenueMicro: bigint;
  gpuHoursMicro: bigint;
  proofs: number;
}

export interface LoanState {
  lender: PublicKey;
  borrower: PublicKey;
  operatorKey: Uint8Array;
  sku: number;
  fleetGpus: number;
  periodS: number;
  debtServiceMicro: bigint;
  minCoverageBps: number;
  currency: string;
  drawnLamports: bigint;
  /** Proven periods only, oldest first. */
  history: PeriodRevenue[];
  updatedAt: bigint;
}

export function decodeLoan(data: Uint8Array): LoanState {
  const r = new Reader(data);
  if (!Buffer.from(r.take(8)).equals(Buffer.from(discriminator("account", "Loan")))) throw new Error("not a Loan account");
  const lender = new PublicKey(r.take(32));
  const borrower = new PublicKey(r.take(32));
  const operatorKey = r.take(32);
  const sku = r.u8();
  const fleetGpus = r.u16();
  const periodS = r.u32();
  const debtServiceMicro = r.u64();
  const minCoverageBps = r.u16();
  const currency = Buffer.from(r.take(3)).toString("ascii");
  const drawnLamports = r.u64();
  const history: PeriodRevenue[] = [];
  for (let i = 0; i < LOAN_HISTORY; i++) {
    history.push({ period: r.u32(), revenueMicro: r.u64(), gpuHoursMicro: r.u64(), proofs: r.u8() });
  }
  return {
    lender,
    borrower,
    operatorKey,
    sku,
    fleetGpus,
    periodS,
    debtServiceMicro,
    minCoverageBps,
    currency,
    drawnLamports,
    history: history.filter((p) => p.proofs > 0).sort((a, b) => a.period - b.period),
    updatedAt: r.i64(),
  };
}

/** Covenant window (COVENANT_WINDOW_S in constants.rs): one quarter. */
export const COVENANT_WINDOW_S = 91 * 86_400;

/** Same as Loan::trailing_coverage_bps: unproven periods inside the window count as zero revenue. */
export function trailingCoverageBps(loan: Pick<LoanState, "history" | "periodS" | "debtServiceMicro">, latest: number): bigint {
  if (loan.history.length === 0) return 0n;
  const first = Math.min(...loan.history.map((p) => p.period));
  const maxPeriods = Math.min(Math.max(Math.ceil(COVENANT_WINDOW_S / loan.periodS), 1), LOAN_HISTORY);
  const start = Math.max(latest - (maxPeriods - 1), first);
  const periods = BigInt(latest - start + 1);
  const revenue = loan.history.filter((p) => p.period >= start && p.period <= latest).reduce((sum, p) => sum + p.revenueMicro, 0n);
  return (revenue * 10_000n) / (periods * loan.debtServiceMicro);
}
