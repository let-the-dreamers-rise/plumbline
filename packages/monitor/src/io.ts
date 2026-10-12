import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { USER_AGENT } from "./constants.js";

/**
 * Network and disk helpers for the snapshot CLI. Every request sends a User-Agent naming the project,
 * times out, and retries once on 429/5xx after a pause. Results that cannot change (closed log windows,
 * transactions) are cached on disk so a daily run makes only a handful of requests.
 */
const TIMEOUT_MS = 30_000;
const RETRY_PAUSE_MS = 3_000;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchText(url: string, init: RequestInit = {}, attempt = 0): Promise<string> {
  const res = await fetch(url, {
    ...init,
    headers: { "user-agent": USER_AGENT, accept: "application/json, text/html;q=0.9", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if ((res.status === 429 || res.status >= 500) && attempt === 0) {
    await pause(RETRY_PAUSE_MS);
    return fetchText(url, init, 1);
  }
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url} -> HTTP ${res.status}`);
  return res.text();
}

export async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const text = await fetchText(url, init);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url} did not return JSON`);
  }
}

export async function postJson(url: string, body: unknown): Promise<unknown> {
  return fetchJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export interface DiskCache {
  /** The cached JSON under `key`, or the loaded value, which is written when `keep(value)` is true. */
  get<T>(key: string, load: () => Promise<T>, keep?: (value: T) => boolean): Promise<T>;
}

export function diskCache(dir: string): DiskCache {
  const file = (key: string) => join(dir, `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  return {
    async get(key, load, keep = () => true) {
      const f = file(key);
      if (existsSync(f)) {
        try {
          return JSON.parse(readFileSync(f, "utf8"));
        } catch {
          // A torn or corrupt cache file: load again.
        }
      }
      const value = await load();
      if (keep(value)) writeJson(f, value);
      return value;
    },
  };
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
}
