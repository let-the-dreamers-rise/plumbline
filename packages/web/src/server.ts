import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Connection, PublicKey } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID } from "@pct/oracle";
import { loadLoan, loadLoans } from "./loans.js";
import { loadState } from "./state.js";
import { badge } from "./zk.js";

// Product page (/), prover onboarding (/prove), docs (/docs), lender view (/lender), price tape (/tape),
// and a public verify page and badge per loan (/loan/<address>, /badge/<address>.svg). Reads the
// oracle straight from Solana; the only thing written is leads.jsonl from the contact form.
const rpc = process.env.SOLANA_RPC_URL?.trim() || "https://api.devnet.solana.com";
const programId = process.env.PCT_PROGRAM_ID?.trim() ? new PublicKey(process.env.PCT_PROGRAM_ID.trim()) : DEFAULT_PROGRAM_ID;
const connection = new Connection(rpc, "confirmed");
const cluster = rpc.includes("devnet") ? "devnet" : rpc.includes("testnet") ? "testnet" : rpc.includes("mainnet") ? "mainnet-beta" : "custom";
const leadsFile = process.env.LEADS_FILE?.trim() || "leads.jsonl";
const page = (f: string) => new URL(`../public/${f}`, import.meta.url);
const pages: Record<string, URL> = {
  "/": page("site/index.html"),
  "/simple": page("landing.html"),
  "/lender": page("lender.html"),
  "/tape": page("index.html"),
  "/prove": page("prove.html"),
  "/docs": page("docs.html"),
};
const port = Number(process.env.PORT ?? 8787);
// Assets of the marketing site (public/site), served at the relative paths its index.html uses.
const assetTypes: Record<string, string> = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

/** A base58 Solana address, or null; anything else never reaches a page or the RPC. */
function address(s: string | undefined): PublicKey | null {
  if (!s || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return null;
  try {
    return new PublicKey(s);
  } catch {
    return null;
  }
}

const json = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));

function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  try {
    if (path === "/api/state") {
      return json(res, 200, await loadState(connection, programId));
    }
    if (path === "/api/loans") {
      const loans = await loadLoans(connection, programId);
      return json(res, 200, { rpc: connection.rpcEndpoint, programId: programId.toBase58(), cluster, fetchedAt: Math.floor(Date.now() / 1000), loans });
    }
    if (path === "/api/lead" && req.method === "POST") {
      const raw = await readBody(req, 4096);
      if (raw === null) return json(res, 413, { error: "too large" });
      let b: Record<string, unknown>;
      try {
        b = JSON.parse(raw) ?? {};
      } catch {
        return json(res, 400, { error: "send JSON" });
      }
      const email = typeof b.email === "string" ? b.email.trim() : "";
      if (!email.includes("@")) return json(res, 400, { error: "email needed" });
      const str = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 500) : "");
      const lead = { email: email.slice(0, 200), fleetGpus: Number(b.fleetGpus) || 0, lender: str(b.lender), note: str(b.note), at: Math.floor(Date.now() / 1000) };
      appendFileSync(leadsFile, JSON.stringify(lead) + "\n");
      return json(res, 200, { ok: true });
    }
    const [, kind, arg] = path.split("/");
    if (kind === "api" && arg === "loan") {
      const key = address(path.split("/")[3]);
      const loan = key && (await loadLoan(connection, programId, key));
      if (!loan) return json(res, 404, { error: "no loan of this program at that address" });
      return json(res, 200, { cluster, explorer: "https://explorer.solana.com", programId: programId.toBase58(), fetchedAt: Math.floor(Date.now() / 1000), ...loan });
    }
    if (kind === "loan" && address(arg)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(page("loan.html")));
      return;
    }
    if (kind === "badge" && arg?.endsWith(".svg")) {
      const key = address(arg.slice(0, -4));
      const loan = key && (await loadLoan(connection, programId, key));
      if (!loan) return json(res, 404, { error: "no loan of this program at that address" });
      const z = loan.zk;
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=60" }).end(badge(z?.status ?? "none", z?.coverageBps ?? 0, z?.asOfPeriod ?? 0));
      return;
    }
    const asset = /^\/(css|js|vendor)\/([A-Za-z0-9._-]+\.(css|js))$/.exec(path);
    if (asset && existsSync(page(`site/${asset[1]}/${asset[2]}`))) {
      res.writeHead(200, { "content-type": assetTypes[`.${asset[3]}`]!, "cache-control": "max-age=300" }).end(readFileSync(page(`site/${asset[1]}/${asset[2]}`)));
      return;
    }
    const file = pages[path];
    if (file) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(file));
      return;
    }
    res.writeHead(404).end("not found");
  } catch (err) {
    json(res, 502, { error: (err as Error).message });
  }
}).listen(port, () => console.log(`dashboard on http://localhost:${port} reading ${rpc}`));
