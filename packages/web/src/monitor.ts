import { readFileSync } from "node:fs";

/**
 * GET /api/monitor: serves the GPU Credit Monitor snapshot written by `npm run monitor:snapshot`
 * (data/monitor/latest.json, or MONITOR_FILE). The file is static, so the handler only reads,
 * checks the schema, and returns it; nothing reaches the network.
 */
export interface MonitorReply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export const DEFAULT_MONITOR_FILE = new URL("../../../data/monitor/latest.json", import.meta.url);
const SCHEMA = "plumbline.monitor/v1";

const reply = (status: number, body: unknown, cache = "no-store"): MonitorReply => ({
  status,
  headers: { "content-type": "application/json", "cache-control": cache },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

/** `read` returns the snapshot text (injectable for tests); errors become 503 or 500 without internals. */
export function monitorReply(read: () => string): MonitorReply {
  let raw: string;
  try {
    raw = read();
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    if (!missing) console.error("monitor snapshot unreadable:", err);
    return reply(503, { error: missing ? "no monitor snapshot yet" : "monitor snapshot unreadable" });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("monitor snapshot is not JSON");
    return reply(500, { error: "monitor snapshot is invalid" });
  }
  const ok =
    parsed !== null &&
    typeof parsed === "object" &&
    (parsed as { schema?: unknown }).schema === SCHEMA &&
    Array.isArray((parsed as { loans?: unknown }).loans) &&
    typeof (parsed as { generatedAt?: unknown }).generatedAt === "string";
  if (!ok) {
    console.error("monitor snapshot has an unexpected shape");
    return reply(500, { error: "monitor snapshot is invalid" });
  }
  // The snapshot changes at most daily; let browsers and proxies keep it for five minutes.
  return reply(200, raw, "public, max-age=300");
}

/** Reader for the snapshot path from MONITOR_FILE or the repository default. */
export function snapshotReader(path: string | undefined): () => string {
  const file = path?.trim() ? path.trim() : DEFAULT_MONITOR_FILE;
  return () => readFileSync(file, "utf8");
}
