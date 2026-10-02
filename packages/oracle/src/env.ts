import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID } from "./program.js";
import { OracleClient } from "./client.js";

/** Reads SOLANA_RPC_URL (default devnet), SOLANA_KEYPAIR (default ~/.config/solana/id.json), PCT_PROGRAM_ID. */
export function clientFromEnv(): OracleClient {
  const rpc = process.env.SOLANA_RPC_URL?.trim() || "https://api.devnet.solana.com";
  const keypairPath = (process.env.SOLANA_KEYPAIR?.trim() || "~/.config/solana/id.json").replace(/^~/, homedir());
  const secret = Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8")) as number[]);
  const programId = process.env.PCT_PROGRAM_ID?.trim() ? new PublicKey(process.env.PCT_PROGRAM_ID.trim()) : DEFAULT_PROGRAM_ID;
  return new OracleClient(new Connection(rpc, "confirmed"), Keypair.fromSecretKey(secret), programId);
}
