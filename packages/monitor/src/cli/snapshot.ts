/**
 * npm run monitor:snapshot [-- --utilization=0.7 --depreciation-years=5 --opex=0]
 *
 * Reads USD.AI's loan book from Arbitrum (public RPC, logs and view calls), the collateral metadata, the
 * public app page (optional), and public GPU prices; writes data/gpu-prices/YYYY-MM-DD.json,
 * data/monitor/latest.json and data/monitor/YYYY-MM-DD.json. Reads only: no keys, no wallet.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AKASH_URL,
  APP_LOANS_URL,
  COLLATERAL_NFT,
  DEFAULT_ASSUMPTIONS,
  METADATA_BASE,
  ROUTER_V2,
  ROUTERS,
  RUNPOD_URL,
  VAST_URL,
  type Assumptions,
} from "../constants.js";
import { blocksNeeded, buildBook, exclusionReason, phaseOf, withCalldataTerms, withTimestamps } from "../book.js";
import { parseCollateral, type Collateral } from "../collateral.js";
import { decodeLoanState, decodeLog, decodeV1BorrowCalldata, routerInterface, type LoanState, type LoanTerms, type RouterEvent } from "../decode.js";
import { parseAppLoans, type Enrichment } from "../enrich.js";
import { diskCache, fetchJson, fetchText, postJson, writeJson } from "../io.js";
import { buildArchive, parseAkash, parseRunpod, parseVast, RUNPOD_QUERY, VAST_QUERY, type PriceSourceName, type Quote } from "../prices.js";
import { getAllLogs, hex, rpc, rpcBatch } from "../rpc.js";
import { buildSnapshot, validateSnapshot } from "../snapshot.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const cache = diskCache(join(root, ".cache", "monitor"));
const problems: string[] = [];
const note = (msg: string) => {
  console.warn(`  ! ${msg}`);
  problems.push(msg);
};

function parseArgs(argv: readonly string[]): Assumptions {
  const get = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const num = (name: string, fallback: number, ok: (n: number) => boolean) => {
    const raw = get(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !ok(n)) throw new Error(`--${name}=${raw} is out of range`);
    return n;
  };
  return {
    ...DEFAULT_ASSUMPTIONS,
    utilization: num("utilization", DEFAULT_ASSUMPTIONS.utilization, (n) => n > 0 && n <= 1),
    depreciationYears: num("depreciation-years", DEFAULT_ASSUMPTIONS.depreciationYears, (n) => n > 0 && n <= 20),
    opexPerGpuHr: num("opex", DEFAULT_ASSUMPTIONS.opexPerGpuHr, (n) => n >= 0 && n < 100),
  };
}

async function readEvents(head: number): Promise<readonly RouterEvent[]> {
  const logs = (await Promise.all(ROUTERS.map((a) => getAllLogs(a, head, cache)))).flat();
  console.log(`  ${logs.length} router logs`);
  return logs.flatMap((l) => {
    try {
      const e = decodeLog(l);
      return e ? [e] : [];
    } catch (err) {
      note(`log ${l.transactionHash}#${Number(l.logIndex)} did not decode: ${(err as Error).message}`);
      return [];
    }
  });
}

/** Origination calldata for active loans whose event carried no terms (v1 and early V2). */
async function calldataTerms(events: readonly RouterEvent[]): Promise<ReadonlyMap<string, LoanTerms | null>> {
  const need = buildBook(events).filter((r) => !r.terms && phaseOf(r) === "active");
  const entries = await Promise.all(
    need.map(async (r) => {
      const tx = await cache.get(`tx-${r.createdTx}`, () => rpc<{ input: string } | null>("eth_getTransactionByHash", [r.createdTx]), (t) => t !== null);
      const terms = tx ? decodeV1BorrowCalldata(tx.input) : null;
      if (!terms) note(`origination calldata of ${r.createdTx} did not decode; terms unknown`);
      return [r.createdTx, terms] as const;
    }),
  );
  return new Map(entries);
}

/** Block timestamps (immutable, so cached on disk), fetched in batches. */
async function blockTimes(blocks: readonly number[]): Promise<ReadonlyMap<number, number>> {
  const missing: number[] = [];
  const known = await Promise.all(
    blocks.map(async (b) => {
      const t = await cache.get<number | null>(`block-${b}`, async () => null, () => false);
      if (t === null) missing.push(b);
      return [b, t] as const;
    }),
  );
  const fetched = await rpcBatch(missing.map((b) => ({ method: "eth_getBlockByNumber", params: [hex(b), false] })));
  const loaded = await Promise.all(
    missing.map(async (b, i) => {
      const blk = fetched[i] as { timestamp?: string } | Error;
      if (blk instanceof Error || !blk?.timestamp) {
        note(`timestamp of block ${b} unavailable`);
        return [b, null] as const;
      }
      const t = Number(BigInt(blk.timestamp));
      await cache.get(`block-${b}`, async () => t);
      return [b, t] as const;
    }),
  );
  return new Map([...known, ...loaded].flatMap(([b, t]) => (t === null ? [] : [[b, t] as const])));
}

async function loanStates(hashes: readonly string[], head: number): Promise<ReadonlyMap<string, LoanState>> {
  const calls = hashes.map((h) => ({ method: "eth_call", params: [{ to: ROUTER_V2, data: routerInterface.encodeFunctionData("loanState", [h]) }, hex(head)] }));
  const results = await rpcBatch(calls);
  return new Map(
    hashes.flatMap((h, i) => {
      const r = results[i];
      if (r instanceof Error || typeof r !== "string") {
        note(`loanState(${h}) failed: ${r instanceof Error ? r.message : "no result"}`);
        return [];
      }
      return [[h, decodeLoanState(r)] as const];
    }),
  );
}

async function collateral(ids: readonly string[], head: number): Promise<ReadonlyMap<string, Collateral>> {
  const calls = ids.map((id) => ({ method: "eth_call", params: [{ to: COLLATERAL_NFT, data: routerInterface.encodeFunctionData("tokenURI", [id]) }, hex(head)] }));
  const uris = await rpcBatch(calls);
  const out: (readonly [string, Collateral])[] = [];
  for (const [i, id] of ids.entries()) {
    const raw = uris[i];
    const decoded = typeof raw === "string" ? String(routerInterface.decodeFunctionResult("tokenURI", raw)[0]) : null;
    // Only follow the URI when it is USD.AI's metadata host; otherwise use the documented pattern.
    const url = decoded?.startsWith(METADATA_BASE) ? decoded : `${METADATA_BASE}${id}`;
    if (!decoded?.startsWith(METADATA_BASE)) note(`tokenURI(${id}) returned ${decoded ?? "an error"}; used ${url}`);
    try {
      out.push([id, parseCollateral(id, url, await fetchJson(url))]);
    } catch (err) {
      note(`collateral metadata ${url}: ${(err as Error).message}`);
    }
  }
  return new Map(out);
}

async function enrichment(): Promise<readonly Enrichment[]> {
  try {
    const list = parseAppLoans(await fetchText(APP_LOANS_URL, { headers: { accept: "text/html" } }));
    if (list.length === 0) note(`${APP_LOANS_URL} parsed to no deals (format changed?); location and offtake unknown`);
    return list;
  } catch (err) {
    note(`${APP_LOANS_URL}: ${(err as Error).message}; location and offtake unknown`);
    return [];
  }
}

async function prices(): Promise<{ bySource: Partial<Record<PriceSourceName, readonly Quote[]>>; errors: string[] }> {
  const reads: readonly [PriceSourceName, () => Promise<readonly Quote[]>][] = [
    ["vast.ai", async () => parseVast(await fetchJson(`${VAST_URL}?q=${encodeURIComponent(JSON.stringify(VAST_QUERY))}`))],
    ["runpod", async () => parseRunpod(await postJson(RUNPOD_URL, { query: RUNPOD_QUERY }))],
    ["akash", async () => parseAkash(await fetchJson(AKASH_URL))],
  ];
  const results = await Promise.all(
    reads.map(async ([name, read]) => {
      try {
        return { name, quotes: await read(), error: null };
      } catch (err) {
        return { name, quotes: null, error: `${name}: ${(err as Error).message}` };
      }
    }),
  );
  const errors = results.flatMap((r) => (r.error ? [r.error] : []));
  errors.forEach(note);
  return { bySource: Object.fromEntries(results.flatMap((r) => (r.quotes ? [[r.name, r.quotes]] : []))), errors };
}

async function main(): Promise<void> {
  const assumptions = parseArgs(process.argv.slice(2));
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const head = Number(BigInt(await rpc<string>("eth_blockNumber", [])));
  console.log(`USD.AI loan book on Arbitrum at block ${head}`);

  const rawEvents = await readEvents(head);
  const terms = await calldataTerms(rawEvents);
  const firstBook = withCalldataTerms(buildBook(rawEvents), terms);
  const isActive = (r: (typeof firstBook)[number]) => phaseOf(r) === "active" && exclusionReason(r) === null;
  const events = withTimestamps(rawEvents, await blockTimes(blocksNeeded(firstBook, firstBook.filter(isActive))));
  const book = withCalldataTerms(buildBook(events), terms);
  const active = book.filter(isActive);
  console.log(`  ${book.length} loan-terms hashes, ${active.length} active USD.AI loans`);

  const states = await loanStates(active.filter((r) => r.router === ROUTER_V2.toLowerCase()).map((r) => r.hash), head);
  const ids = [...new Set(active.flatMap((r) => r.terms?.collateralTokenIds ?? []))];
  const coll = await collateral(ids, head);
  console.log(`  ${states.size} loan states, ${coll.size}/${ids.length} collateral documents`);
  const enrich = await enrichment();
  console.log(`  ${enrich.length} deals from the app page`);

  const { bySource, errors } = await prices();
  const archive = buildArchive(bySource, now, errors);
  const priceArchivePath = `data/gpu-prices/${date}.json`;
  writeJson(join(root, priceArchivePath), archive);
  console.log(`  prices: ${Object.entries(archive.models).map(([m, p]) => `${m} ${p.medianUsdPerGpuHr ?? "n/a"}`).join(", ")}`);

  const snapshot = buildSnapshot({
    events,
    calldataTerms: terms,
    states,
    collateral: coll,
    enrichment: enrich,
    prices: archive,
    priceArchivePath,
    assumptions,
    now,
    asOfBlock: head,
    unavailable: problems,
  });
  const invalid = validateSnapshot(snapshot);
  if (invalid.length) throw new Error(`snapshot failed validation: ${invalid.join("; ")}`);
  writeJson(join(root, "data/monitor/latest.json"), snapshot);
  writeJson(join(root, `data/monitor/${date}.json`), snapshot);
  const b = snapshot.book;
  console.log(
    `wrote data/monitor/latest.json: ${b.activeLoans} loans, $${((b.outstandingUsd.value ?? 0) / 1e6).toFixed(2)}M outstanding, ` +
      `${b.flagged.length} flagged, ${snapshot.unavailable.length} gaps`,
  );
}

main().catch((err) => {
  console.error("monitor snapshot failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
