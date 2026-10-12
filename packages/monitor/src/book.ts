import { COLLATERAL_NFT, USDAI } from "./constants.js";
import type { LoanTerms, RouterEvent } from "./decode.js";
import { principalOf } from "./decode.js";

/**
 * Folds decoded router events into one record per loan-terms hash, following migrations (v1 to V2) and
 * refinances (old hash to new hash). Pure: the CLI does all the reading.
 */
export interface Repayment {
  readonly tx: string;
  readonly block: number;
  readonly timestamp: number | null;
  readonly principal: bigint;
  readonly interest: bigint;
  readonly prepayment: bigint;
  readonly isRepaid: boolean;
}

export interface LoanRecord {
  readonly hash: string;
  readonly router: string;
  /** Tx that created this hash: origination, migration or refinance. */
  readonly createdTx: string;
  readonly createdBlock: number;
  readonly createdAt: number | null;
  readonly createdBy: "originated" | "migrated" | "refinanced";
  readonly terms: LoanTerms | null;
  /** Where the terms came from: the event itself, or decoded calldata of the origination tx. */
  readonly termsSource: "event" | "calldata" | null;
  readonly borrower: string | null;
  /** Principal from a legacy LoanOriginated event (v1), when the terms are not in the event. */
  readonly eventPrincipal: bigint | null;
  readonly predecessor: string | null;
  readonly successor: string | null;
  readonly repayments: readonly Repayment[];
  readonly breached: boolean;
  readonly liquidated: boolean;
}

export type LoanPhase = "active" | "repaid" | "liquidated" | "superseded";

const empty = (hash: string, e: RouterEvent, createdBy: LoanRecord["createdBy"]): LoanRecord => ({
  hash,
  router: e.router,
  createdTx: e.tx,
  createdBlock: e.block,
  createdAt: e.timestamp,
  createdBy,
  terms: null,
  termsSource: null,
  borrower: null,
  eventPrincipal: null,
  predecessor: null,
  successor: null,
  repayments: [],
  breached: false,
  liquidated: false,
});

type Book = ReadonlyMap<string, LoanRecord>;

function upsert(book: Book, hash: string, init: () => LoanRecord, change: (r: LoanRecord) => LoanRecord): Book {
  const next = new Map(book);
  next.set(hash, change(book.get(hash) ?? init()));
  return next;
}

function apply(book: Book, e: RouterEvent): Book {
  switch (e.kind) {
    case "originated":
      return upsert(book, e.hash, () => empty(e.hash, e, "originated"), (r) => ({
        ...r,
        terms: e.terms ?? r.terms,
        termsSource: e.terms ? "event" : r.termsSource,
        borrower: e.borrower ?? r.borrower,
        eventPrincipal: e.principal ?? r.eventPrincipal,
      }));
    case "migrated":
    case "refinanced": {
      const linked = upsert(book, e.oldHash, () => empty(e.oldHash, e, "originated"), (r) => ({ ...r, successor: e.hash }));
      return upsert(linked, e.hash, () => empty(e.hash, e, e.kind), (r) => ({
        ...r,
        terms: e.terms,
        termsSource: "event",
        borrower: e.terms.borrower,
        predecessor: e.oldHash,
      }));
    }
    case "migratedOut":
      return book;
    case "repaid":
      return upsert(book, e.hash, () => empty(e.hash, e, "originated"), (r) => ({
        ...r,
        borrower: r.borrower ?? e.borrower,
        repayments: [
          ...r.repayments,
          { tx: e.tx, block: e.block, timestamp: e.timestamp, principal: e.principal, interest: e.interest, prepayment: e.prepayment, isRepaid: e.isRepaid },
        ],
      }));
    case "breached":
      return upsert(book, e.hash, () => empty(e.hash, e, "originated"), (r) => ({ ...r, breached: true }));
    case "liquidated":
      return upsert(book, e.hash, () => empty(e.hash, e, "originated"), (r) => ({ ...r, liquidated: true }));
  }
}

/** One record per loan-terms hash, in the order the hashes first appeared. */
export function buildBook(events: readonly RouterEvent[]): readonly LoanRecord[] {
  const ordered = [...events].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  return [...ordered.reduce<Book>(apply, new Map()).values()];
}

export function phaseOf(r: LoanRecord): LoanPhase {
  if (r.successor) return "superseded";
  if (r.liquidated) return "liquidated";
  if (r.repayments.some((p) => p.isRepaid)) return "repaid";
  return "active";
}

/** Attaches terms decoded from origination calldata to records whose event did not carry them. */
export function withCalldataTerms(book: readonly LoanRecord[], byTx: ReadonlyMap<string, LoanTerms | null>): readonly LoanRecord[] {
  return book.map((r) => {
    const terms = r.terms ? null : byTx.get(r.createdTx);
    return terms ? { ...r, terms, termsSource: "calldata" as const, borrower: r.borrower ?? terms.borrower } : r;
  });
}

/** Why a record is not a USD.AI GPU loan (test loans on other tokens), or null when it is one. */
export function exclusionReason(r: LoanRecord): string | null {
  if (!r.terms) return null;
  if (r.terms.collateralToken !== COLLATERAL_NFT) return `collateral ${r.terms.collateralToken} is not the USD.AI Tokenized Hardware NFT`;
  if (r.terms.currencyToken !== USDAI) return `currency ${r.terms.currencyToken} is not USDai`;
  return null;
}

/** The first record of a migration/refinance chain, for the original origination time. */
export function rootOf(book: readonly LoanRecord[], r: LoanRecord): LoanRecord {
  const byHash = new Map(book.map((x) => [x.hash, x]));
  const walk = (x: LoanRecord, depth: number): LoanRecord => {
    const prev = x.predecessor ? byHash.get(x.predecessor) : undefined;
    return prev && depth < 32 ? walk(prev, depth + 1) : x;
  };
  return walk(r, 0);
}

/** Blocks whose timestamps the active loans need: creation, chain root and last repayment. */
export function blocksNeeded(book: readonly LoanRecord[], active: readonly LoanRecord[]): readonly number[] {
  const blocks = active.flatMap((r) => [r.createdBlock, rootOf(book, r).createdBlock, ...(r.repayments.length ? [r.repayments.at(-1)!.block] : [])]);
  return [...new Set(blocks)].sort((a, b) => a - b);
}

/** Fills missing event timestamps (the public RPC returns blockTimestamp 0x0 for older logs) from a block-time map. */
export function withTimestamps<E extends { readonly block: number; readonly timestamp: number | null }>(events: readonly E[], times: ReadonlyMap<number, number>): readonly E[] {
  return events.map((e) => (e.timestamp === null && times.has(e.block) ? { ...e, timestamp: times.get(e.block)! } : e));
}

/** Principal at origination/refinance, from the terms or else the legacy event; 0n when neither is known. */
export function originalPrincipal(r: LoanRecord): bigint {
  return r.terms ? principalOf(r.terms) : (r.eventPrincipal ?? 0n);
}

/** Principal still owed under this hash: original less repaid principal and prepayments (event sums). */
export function outstandingPrincipal(r: LoanRecord): bigint {
  const paid = r.repayments.reduce((s, p) => s + p.principal + p.prepayment, 0n);
  const left = originalPrincipal(r) - paid;
  return left > 0n ? left : 0n;
}
