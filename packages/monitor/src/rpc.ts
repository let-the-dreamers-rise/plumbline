import { ARBITRUM_RPC, FINALITY_BLOCKS, LOG_WINDOW, START_BLOCK } from "./constants.js";
import type { RawLog } from "./decode.js";
import { postJson, type DiskCache } from "./io.js";

/** Minimal JSON-RPC client for the public Arbitrum endpoint (batching keeps the request count low). */
interface RpcResponse {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

export async function rpc<T>(method: string, params: readonly unknown[], url = ARBITRUM_RPC): Promise<T> {
  const r = (await postJson(url, { jsonrpc: "2.0", id: 1, method, params })) as RpcResponse;
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result as T;
}

/** Sends calls as JSON-RPC batches of `size`; each result is the value or an Error. */
export async function rpcBatch(calls: readonly { method: string; params: readonly unknown[] }[], size = 25, url = ARBITRUM_RPC): Promise<readonly (unknown | Error)[]> {
  const chunks = Array.from({ length: Math.ceil(calls.length / size) }, (_, i) => calls.slice(i * size, i * size + size));
  const out: (unknown | Error)[][] = [];
  for (const [c, chunk] of chunks.entries()) {
    const body = chunk.map((call, i) => ({ jsonrpc: "2.0", id: c * size + i, ...call }));
    const res = (await postJson(url, body)) as RpcResponse[];
    if (!Array.isArray(res)) throw new Error("RPC batch did not return an array");
    const byId = new Map(res.map((r) => [r.id, r]));
    out.push(body.map((b) => {
      const r = byId.get(b.id);
      return !r ? new Error("missing from batch") : r.error ? new Error(r.error.message) : r.result;
    }));
  }
  return out.flat();
}

export const hex = (n: number) => "0x" + n.toString(16);

/** Block windows [from, to] aligned to LOG_WINDOW from START_BLOCK up to `head`. */
export function windows(head: number, start = START_BLOCK, size = LOG_WINDOW): readonly (readonly [number, number])[] {
  const n = head >= start ? Math.floor((head - start) / size) + 1 : 0;
  return Array.from({ length: n }, (_, i) => [start + i * size, Math.min(start + (i + 1) * size - 1, head)] as const);
}

/** All logs of `address` up to `head`; windows that end well behind the head come from the disk cache. */
export async function getAllLogs(address: string, head: number, cache: DiskCache): Promise<readonly RawLog[]> {
  const out: RawLog[][] = [];
  for (const [from, to] of windows(head)) {
    const closed = to + FINALITY_BLOCKS < head && to === from + LOG_WINDOW - 1;
    const load = () => rpc<RawLog[]>("eth_getLogs", [{ address, fromBlock: hex(from), toBlock: hex(to) }]);
    out.push(closed ? await cache.get(`logs-${address.toLowerCase()}-${from}-${to}`, load) : await load());
  }
  return out.flat();
}
