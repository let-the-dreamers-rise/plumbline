import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Connection, PublicKey } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID } from "@pct/oracle";
import { loadLoan, loadLoans } from "./loans.js";
import { loadState } from "./state.js";
import { badge } from "./zk.js";
import { bodyKind, LEAD_BODY_LIMIT, leadRedirect, parseLead } from "./lead.js";

// Product page (/), prover onboarding (/prove), docs (/docs), lender view (/lender), price tape (/tape),
// and a public verify page and badge per loan (/loan/<address>, /badge/<address>.svg). Reads the
// oracle straight from Solana; the only thing written is leads.jsonl from the contact form.
const rpc = process.env.SOLANA_RPC_URL?.trim() || "https://api.devnet.solana.com";
const programId = process.env.PCT_PROGRAM_ID?.trim() ? new PublicKey(process.env.PCT_PROGRAM_ID.trim()) : DEFAULT_PROGRAM_ID;
const connection = new Connection(rpc, "confirmed");
const cluster = rpc.includes("devnet") ? "devnet" : rpc.includes("testnet") ? "testnet" : rpc.includes("mainnet") ? "mainnet-beta" : /localhost|127\.0\.0\.1/.test(rpc) ? "localnet" : "custom";
// Explorer query for a transaction or account link; a local or custom RPC uses the explorer's custom-RPC mode.
const explorerQuery = cluster === "localnet" || cluster === "custom" ? `?cluster=custom&customUrl=${encodeURIComponent(rpc)}` : `?cluster=${cluster}`;
const leadsFile = process.env.LEADS_FILE?.trim() || "leads.jsonl";
const page = (f: string) => new URL(`../public/${f}`, import.meta.url);
const pages: Record<string, URL> = {
  // The product page; its own theme.css and hero.js are served at the root next to it.
  "/": page("site/lens/index.html"),
  "/lender": page("lender.html"),
  "/tape": page("index.html"),
  "/prove": page("prove.html"),
  "/docs": page("docs.html"),
};
// Retired design explorations and the first landing page: send old links home.
const retired = new Set(["/simple", "/hallmark", "/hallmark/", "/lens", "/lens/", "/lattice", "/lattice/"]);
const port = Number(process.env.PORT ?? 8787);

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
      // A plain form post (JavaScript off) gets a 303 back to its page; the page script sends JSON and gets JSON.
      const isForm = bodyKind(req.headers["content-type"]) === "form";
      const reply = (status: number, body: Record<string, unknown>) =>
        isForm ? void res.writeHead(303, { location: leadRedirect(req.headers.referer, status === 200 ? "thanks" : "error") }).end() : json(res, status, body);
      const raw = await readBody(req, LEAD_BODY_LIMIT);
      if (raw === null) return reply(413, { error: "too large" });
      const parsed = parseLead(raw, req.headers["content-type"], Math.floor(Date.now() / 1000));
      if (!parsed.ok) return reply(parsed.status, { error: parsed.error });
      try {
        appendFileSync(leadsFile, JSON.stringify(parsed.lead) + "\n");
      } catch (err) {
        console.error("lead not saved:", err);
        return reply(500, { error: "could not save the request, please email us instead" });
      }
      return reply(200, { ok: true });
    }
    const [, kind, arg] = path.split("/");
    if (kind === "api" && arg === "loan") {
      const key = address(path.split("/")[3]);
      const loan = key && (await loadLoan(connection, programId, key));
      if (!loan) return json(res, 404, { error: "no loan of this program at that address" });
      return json(res, 200, { cluster, explorer: "https://explorer.solana.com", explorerQuery, programId: programId.toBase58(), fetchedAt: Math.floor(Date.now() / 1000), ...loan });
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
    // /css|js|vendor/<file>, and the product page's own /theme.css and /hero.js.
    const asset =
      /^\/(css|js|vendor)\/([A-Za-z0-9._-]+\.(css|js))$/.exec(path) ??
      /^\/()((?:theme\.css|hero\.js))$/.exec(path)?.map((m, i) => (i === 1 ? "lens" : m));
    const assetFile = asset && page(`site/${asset[1]}/${asset[2]}`);
    if (asset && assetFile && existsSync(assetFile)) {
      const type = asset[2]!.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
      res.writeHead(200, { "content-type": type, "cache-control": "max-age=300" }).end(readFileSync(assetFile));
      return;
    }
    if (retired.has(path)) {
      res.writeHead(301, { location: "/" }).end();
      return;
    }
    const file = pages[path];
    if (file) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(file));
      return;
    }
    res.writeHead(404).end("not found");
  } catch (err) {
    // Log the details here; never send RPC or stack internals to the client.
    console.error(`${req.method} ${path} failed:`, err);
    if (!res.headersSent) json(res, 502, { error: "upstream read failed, try again shortly" });
  }
}).listen(port, () => console.log(`dashboard on http://localhost:${port} reading ${rpc}`));
