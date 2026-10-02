import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Connection, PublicKey } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID } from "@pct/oracle";
import { loadState } from "./state.js";

// Posted-vs-paid dashboard. Reads the oracle straight from Solana; no database.
const rpc = process.env.SOLANA_RPC_URL?.trim() || "https://api.devnet.solana.com";
const programId = process.env.PCT_PROGRAM_ID?.trim() ? new PublicKey(process.env.PCT_PROGRAM_ID.trim()) : DEFAULT_PROGRAM_ID;
const connection = new Connection(rpc, "confirmed");
const page = new URL("../public/index.html", import.meta.url);
const port = Number(process.env.PORT ?? 8787);

createServer(async (req, res) => {
  try {
    if (req.url === "/api/state") {
      const state = await loadState(connection, programId);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(state));
      return;
    }
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(page));
      return;
    }
    res.writeHead(404).end("not found");
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: (err as Error).message }));
  }
}).listen(port, () => console.log(`dashboard on http://localhost:${port} reading ${rpc}`));
