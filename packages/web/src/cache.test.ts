import { describe, expect, it } from "vitest";
import { createTtlCache, DEFAULT_CACHE_TTL_MS, ttlFromEnv } from "./cache.js";

/** A clock the test moves by hand. */
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

const counter = <V>(value: V) => {
  let calls = 0;
  return { load: () => (calls++, Promise.resolve(value)), calls: () => calls };
};

describe("createTtlCache", () => {
  it("serves a value from cache until the TTL passes, then loads again", async () => {
    const c = clock();
    const cache = createTtlCache<number>({ ttlMs: 30_000, now: c.now });
    const src = counter(7);
    expect(await cache.get("loans", src.load)).toBe(7);
    c.advance(29_999);
    expect(await cache.get("loans", src.load)).toBe(7);
    expect(src.calls()).toBe(1);
    c.advance(1);
    expect(await cache.get("loans", src.load)).toBe(7);
    expect(src.calls()).toBe(2);
  });

  it("keeps keys apart", async () => {
    const cache = createTtlCache<string>({ ttlMs: 1_000, now: clock().now });
    expect(await cache.get("a", () => Promise.resolve("A"))).toBe("A");
    expect(await cache.get("b", () => Promise.resolve("B"))).toBe("B");
    expect(await cache.get("a", () => Promise.resolve("other"))).toBe("A");
  });

  it("shares one in-flight load between concurrent callers", async () => {
    const cache = createTtlCache<number>({ ttlMs: 1_000, now: clock().now });
    let release!: (v: number) => void;
    let calls = 0;
    const load = () => (calls++, new Promise<number>((r) => (release = r)));
    const both = Promise.all([cache.get("k", load), cache.get("k", load)]);
    release(5);
    expect(await both).toEqual([5, 5]);
    expect(calls).toBe(1);
  });

  it("does not cache a failure, so the next call retries", async () => {
    const cache = createTtlCache<number>({ ttlMs: 60_000, now: clock().now });
    await expect(cache.get("k", () => Promise.reject(new Error("429 Too Many Requests")))).rejects.toThrow("429");
    expect(cache.size()).toBe(0);
    expect(await cache.get("k", () => Promise.resolve(1))).toBe(1);
  });

  it("evicts the oldest keys beyond maxEntries", async () => {
    const cache = createTtlCache<number>({ ttlMs: 60_000, maxEntries: 2, now: clock().now });
    await cache.get("a", () => Promise.resolve(1));
    await cache.get("b", () => Promise.resolve(2));
    await cache.get("c", () => Promise.resolve(3));
    expect(cache.size()).toBe(2);
    const a = counter(9);
    expect(await cache.get("a", a.load)).toBe(9);
    expect(a.calls()).toBe(1);
  });

  it("with ttlMs 0 never caches", async () => {
    const cache = createTtlCache<number>({ ttlMs: 0, now: clock().now });
    const src = counter(1);
    await cache.get("k", src.load);
    await cache.get("k", src.load);
    expect(src.calls()).toBe(2);
    expect(cache.size()).toBe(0);
  });

  it("clear drops everything", async () => {
    const cache = createTtlCache<number>({ ttlMs: 60_000, now: clock().now });
    await cache.get("k", () => Promise.resolve(1));
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it("refuses bad options", () => {
    expect(() => createTtlCache({ ttlMs: -1 })).toThrow("ttlMs");
    expect(() => createTtlCache({ ttlMs: Number.NaN })).toThrow("ttlMs");
    expect(() => createTtlCache({ ttlMs: 1, maxEntries: 0 })).toThrow("maxEntries");
  });
});

describe("ttlFromEnv", () => {
  it("reads milliseconds and falls back on missing or bad values", () => {
    expect(ttlFromEnv("5000")).toBe(5_000);
    expect(ttlFromEnv(" 0 ")).toBe(0);
    expect(ttlFromEnv(undefined)).toBe(DEFAULT_CACHE_TTL_MS);
    expect(ttlFromEnv("")).toBe(DEFAULT_CACHE_TTL_MS);
    expect(ttlFromEnv("soon")).toBe(DEFAULT_CACHE_TTL_MS);
    expect(ttlFromEnv("-5")).toBe(DEFAULT_CACHE_TTL_MS);
  });
});
