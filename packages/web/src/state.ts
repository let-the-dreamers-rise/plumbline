import { Connection, PublicKey } from "@solana/web3.js";
import { computeIndex, type Observation } from "@pct/core";
import { DEFAULT_PROGRAM_ID, OraclePdas, PROVIDER_IDS, decodeBook, decodeConfig, type BookState, type IndexParams } from "@pct/oracle";
import { parseObservations, type ObservationAccepted } from "./events.js";

const PROVIDER_NAMES = new Map(Object.entries(PROVIDER_IDS).map(([name, id]) => [id, name]));
export const providerName = (id: number): string => PROVIDER_NAMES.get(id) ?? `provider-${id}`;

export interface Proven extends ObservationAccepted {
  provider: string;
  signature: string;
  slot: number;
}

export interface DashboardState {
  rpc: string;
  programId: string;
  fetchedAt: number;
  paid: BookView | null;
  list: BookView | null;
  /** Reclaim attestor addresses the program accepts signatures from. */
  attestors: string[];
  /** Newest first. Every row is an onchain ObservationAccepted event with its transaction. */
  proofs: Proven[];
  /** The off-chain TypeScript reference recomputed from the paid book's slots. */
  recomputed: { valueMicro: number | null; status: string; matches: boolean } | null;
}

export interface BookView {
  address: string;
  status: BookState["status"];
  valueMicro: number;
  used: number;
  rejected: number;
  updatedAt: number;
  slots: { provider: string; priceMicro: number; observedAt: number }[];
}

function view(address: PublicKey, b: BookState): BookView {
  return {
    address: address.toBase58(),
    status: b.status,
    valueMicro: Number(b.valueMicro),
    used: b.used,
    rejected: b.rejected,
    updatedAt: Number(b.updatedAt),
    slots: b.slots.map((s) => ({ provider: providerName(s.providerId), priceMicro: Number(s.priceMicro), observedAt: Number(s.observedAt) })),
  };
}

async function proofsFor(connection: Connection, programId: PublicKey, book: PublicKey, limit: number): Promise<Proven[]> {
  const sigs = await connection.getSignaturesForAddress(book, { limit }, "confirmed");
  const ok = sigs.filter((s) => s.err === null);
  const txs = await Promise.all(ok.map((s) => connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })));
  return txs.flatMap((tx, i) =>
    parseObservations(tx?.meta?.logMessages ?? [], programId.toBase58()).map((o) => ({ ...o, provider: providerName(o.providerId), signature: ok[i]!.signature, slot: ok[i]!.slot })),
  );
}

/** Same math as crank_index, run off-chain from the book's slots, to show anyone can recompute it. */
function recompute(paid: BookView, p: IndexParams, nowS: number): DashboardState["recomputed"] {
  const obs: Observation[] = paid.slots.map((s, i) => ({
    sourceId: String(i),
    provider: s.provider,
    sku: "H100",
    kind: "paid",
    microUsdPerGpuHour: s.priceMicro,
    observedAtS: s.observedAt,
    weight: 1,
  }));
  const r = computeIndex(obs, "H100", "paid", {
    nowS,
    maxStalenessS: p.maxStalenessS,
    maxFutureSkewS: p.maxFutureSkewS,
    minSources: p.minProviders,
    providerCap: p.providerCapBps / 10_000,
    madK: p.madKMilli / 1_000,
    madFloorFraction: p.madFloorBps / 10_000,
  });
  const matches = r.status === paid.status && (r.status !== "live" || r.valueMicroUsd === paid.valueMicro);
  return { valueMicro: r.valueMicroUsd, status: r.status, matches };
}

export async function loadState(connection: Connection, programId: PublicKey = DEFAULT_PROGRAM_ID): Promise<DashboardState> {
  const pdas = new OraclePdas(programId);
  const [paidKey, listKey] = [pdas.book(0, 0), pdas.book(0, 1)];
  const [paidInfo, listInfo, configInfo] = await connection.getMultipleAccountsInfo([paidKey, listKey, pdas.config()], "confirmed");
  const config = configInfo ? decodeConfig(configInfo.data) : null;
  const paid = paidInfo ? view(paidKey, decodeBook(paidInfo.data)) : null;
  const list = listInfo ? view(listKey, decodeBook(listInfo.data)) : null;
  const proofs = (await Promise.all([proofsFor(connection, programId, paidKey, 40), proofsFor(connection, programId, listKey, 20)])).flat().sort((a, b) => b.slot - a.slot);
  return {
    rpc: connection.rpcEndpoint,
    programId: programId.toBase58(),
    fetchedAt: Math.floor(Date.now() / 1000),
    paid,
    list,
    proofs,
    attestors: config?.attestors ?? [],
    recomputed: paid && config && paid.updatedAt > 0 ? recompute(paid, config.params, paid.updatedAt) : null,
  };
}
