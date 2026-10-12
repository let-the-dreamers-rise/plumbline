import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Keypair } from "@solana/web3.js";

/** --keypair, else ANCHOR_WALLET, else ~/.config/solana/id.json (solana-keygen JSON array). */
export function keypairPath(flag?: string): string {
  return flag ?? process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config/solana/id.json");
}

export function loadKeypair(flag?: string): Keypair {
  const p = keypairPath(flag);
  if (!fs.existsSync(p)) throw new Error(`no keypair at ${p} (pass --keypair or set ANCHOR_WALLET)`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}
