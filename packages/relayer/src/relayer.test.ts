import { describe, expect, it } from "vitest";
import { Wallet } from "ethers";
import { ExchangeClient } from "@nktkas/hyperliquid";
import type { BookState } from "@pct/oracle";
import { clampStep, decide, formatHlPrice } from "./price.js";
import { Relayer, setOracleAction, type SetOracle } from "./relayer.js";

const NOW = 1_790_900_000;
const book = (valueMicro: bigint, over: Partial<BookState> = {}): BookState => ({
  sku: 0, kind: 0, len: 4, slots: [], valueMicro, status: "live", used: 4, rejected: 0, updatedAt: BigInt(NOW - 60), ...over,
});
const policy = { maxAgeS: 1800, maxStepBps: 100 };

describe("formatHlPrice", () => {
  it("keeps 5 significant figures and the decimals limit", () => {
    expect(formatHlPrice(2_490_000n, 2)).toBe("2.49");
    expect(formatHlPrice(2_712_345n, 2)).toBe("2.7123");
    expect(formatHlPrice(12_290_000n, 2)).toBe("12.29");
    expect(formatHlPrice(123_456_789n, 2)).toBe("123.46");
    expect(formatHlPrice(2_123_456n, 4)).toBe("2.12");
    expect(formatHlPrice(3_000_000n, 2)).toBe("3");
    expect(() => formatHlPrice(0n, 2)).toThrow();
  });
});

describe("decide", () => {
  it("holds when the index is frozen, missing or stale", () => {
    expect(decide(null, NOW, null, policy)).toMatchObject({ post: false });
    expect(decide(book(2_490_000n, { status: "frozen" }), NOW, null, policy)).toMatchObject({ post: false, reason: expect.stringContaining("frozen") });
    expect(decide(book(2_490_000n, { updatedAt: BigInt(NOW - 3600) }), NOW, null, policy)).toMatchObject({ post: false, reason: expect.stringContaining("stale") });
  });

  it("clamps each step to 1%", () => {
    expect(clampStep(null, 2_490_000n, 100)).toBe(2_490_000n);
    expect(clampStep(2_000_000n, 3_000_000n, 100)).toBe(2_020_000n);
    expect(clampStep(2_000_000n, 1_000_000n, 100)).toBe(1_980_000n);
    expect(clampStep(2_000_000n, 2_010_000n, 100)).toBe(2_010_000n);
  });
});

describe("Relayer", () => {
  it("walks the HIP-3 oracle toward a shocked index one clamp at a time", async () => {
    let value = 2_490_000n;
    const sent: SetOracle[] = [];
    const r = new Relayer({ dex: "pct", coin: "pct:H100", szDecimals: 2, sku: 0, kind: 0, ...policy }, async () => book(value), async (a) => void sent.push(a), () => NOW);
    expect(await r.tick()).toEqual({ posted: "2.49", note: "at index" });
    value = 3_000_000n;
    expect((await r.tick()).posted).toBe("2.5149");
    expect((await r.tick()).posted).toBe("2.54");
    expect(sent[0]).toEqual(setOracleAction("pct", "pct:H100", "2.49"));
  });

  it("produces an action the Hyperliquid SDK accepts and signs", async () => {
    const captured: unknown[] = [];
    const transport = { isTestnet: true, request: async <T>(_e: string, payload: unknown) => (captured.push(payload), { status: "ok", response: { type: "default" } } as T) };
    const client = new ExchangeClient({ transport, wallet: Wallet.createRandom() });
    await client.perpDeploy(setOracleAction("pct", "pct:H100", "2.49"));
    const payload = captured[0] as { action: { type: string; setOracle: unknown }; signature: unknown };
    expect(payload.action.type).toBe("perpDeploy");
    expect(payload.action.setOracle).toEqual(setOracleAction("pct", "pct:H100", "2.49").setOracle);
    expect(payload.signature).toBeDefined();
  });
});
