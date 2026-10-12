import { Connection, type PublicKey } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID, OraclePdas, decodeBook, type BookState } from "@pct/oracle";
import { decide, formatHlPrice, type RelayPolicy } from "./price.js";

/** The HIP-3 setOracle action body for one asset. */
export function setOracleAction(dex: string, coin: string, px: string) {
  return {
    setOracle: {
      dex,
      oraclePxs: [[coin, px]] as [string, string][],
      markPxs: [[[coin, px]]] as [string, string][][],
      externalPerpPxs: [[coin, px]] as [string, string][],
    },
  };
}

export type SetOracle = ReturnType<typeof setOracleAction>;

export interface RelayerConfig extends RelayPolicy {
  dex: string;
  coin: string;
  szDecimals: number;
  sku: number;
  kind: number;
}

/** Reads a Book account with no signer (relaying is read-only on Solana). */
export async function readBook(connection: Connection, sku: number, kind: number, programId: PublicKey = DEFAULT_PROGRAM_ID): Promise<BookState | null> {
  const info = await connection.getAccountInfo(new OraclePdas(programId).book(sku, kind), "confirmed");
  return info ? decodeBook(info.data) : null;
}

export interface TickResult {
  posted: string | null;
  note: string;
}

/**
 * One relay step: read the Solana index, apply the freshness and step-clamp policy, and post
 * setOracle. `send` is injected so tests and dry runs never touch Hyperliquid.
 */
export class Relayer {
  private last: bigint | null = null;

  constructor(
    private readonly cfg: RelayerConfig,
    private readonly read: () => Promise<BookState | null>,
    private readonly send: (action: SetOracle) => Promise<unknown>,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async tick(): Promise<TickResult> {
    const d = decide(await this.read(), this.now(), this.last, this.cfg);
    if (!d.post) return { posted: null, note: d.reason };
    const px = formatHlPrice(d.micro, this.cfg.szDecimals);
    await this.send(setOracleAction(this.cfg.dex, this.cfg.coin, px));
    this.last = d.micro;
    const target = formatHlPrice(d.target, this.cfg.szDecimals);
    return { posted: px, note: px === target ? "at index" : `walking toward ${target}` };
  }
}
