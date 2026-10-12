// Cluster selection. Localnet by default, devnet on request, mainnet never.
import { Connection } from "@solana/web3.js";

export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const LOCALNET_URL = "http://127.0.0.1:8899";
export const DEVNET_URL = "https://api.devnet.solana.com";

export type Cluster = { name: "localnet" | "devnet"; url: string };

export class MainnetRefused extends Error {
  constructor(what: string) {
    super(`refusing mainnet (${what}): Plumbline v0 runs on localnet and devnet only`);
    this.name = "MainnetRefused";
  }
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "[::1]", "::1"]);

/**
 * `cluster` is "localnet" | "devnet" | an http(s) RPC URL. A URL is accepted only if it points at a
 * local validator or its host names devnet; anything that names mainnet is refused outright.
 */
export function resolveCluster(cluster?: string, url?: string): Cluster {
  const c = (cluster ?? "localnet").trim();
  if (/mainnet/i.test(c) || (url && /mainnet/i.test(url))) throw new MainnetRefused(url ?? c);
  if (url) return { name: classifyUrl(url), url };
  if (c === "localnet" || c === "localhost") return { name: "localnet", url: LOCALNET_URL };
  if (c === "devnet") return { name: "devnet", url: DEVNET_URL };
  if (/^https?:\/\//.test(c)) return { name: classifyUrl(c), url: c };
  throw new Error(`unknown cluster "${c}": use localnet, devnet, or an RPC URL for one of them`);
}

function classifyUrl(u: string): "localnet" | "devnet" {
  let host: string;
  try { host = new URL(u).hostname; } catch { throw new Error(`not a URL: ${u}`); }
  if (LOCAL_HOSTS.has(host)) return "localnet";
  if (/devnet/i.test(host)) return "devnet";
  throw new Error(`RPC ${host} is neither a local validator nor a devnet endpoint; refusing (mainnet is never allowed)`);
}

/** Second line of defence: ask the node for its genesis hash and refuse mainnet-beta's. */
export async function assertNotMainnet(conn: Connection): Promise<void> {
  const g = await conn.getGenesisHash();
  if (g === MAINNET_GENESIS) throw new MainnetRefused(`RPC reports mainnet-beta genesis ${g}`);
}

export function explorerUrl(kind: "address" | "tx", id: string, c: Cluster): string {
  const q = c.name === "devnet" ? "?cluster=devnet" : `?cluster=custom&customUrl=${encodeURIComponent(c.url)}`;
  return `https://explorer.solana.com/${kind}/${id}${q}`;
}
