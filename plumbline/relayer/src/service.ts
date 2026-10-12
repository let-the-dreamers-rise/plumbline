// Inbox directory + HTTP POST /bundles feeding one serial queue (the prover is heavy: one job at a time).
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { Logger, Outcome, Relayer } from "./pipeline.js";
import type { State } from "./state.js";

export const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;

export class Inbox {
  readonly done: string; readonly rejected: string; readonly failed: string;
  private queue: Promise<unknown> = Promise.resolve();
  private seen = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(readonly dir: string, private relayer: Relayer, private log: Logger) {
    this.done = path.join(dir, "done"); this.rejected = path.join(dir, "rejected"); this.failed = path.join(dir, "failed");
    for (const d of [dir, this.done, this.rejected, this.failed]) fs.mkdirSync(d, { recursive: true });
  }

  /** Queue every *.json in the inbox not already queued; resolves when this scan's jobs are done. */
  scan(): Promise<Outcome[]> {
    const names = fs.readdirSync(this.dir).filter((n) => n.endsWith(".json") && !this.seen.has(n)).sort();
    return Promise.all(names.map((n) => { this.seen.add(n); return this.enqueue(n); }));
  }

  private enqueue(name: string): Promise<Outcome> {
    const job = this.queue.then(async () => {
      const file = path.join(this.dir, name);
      let out: Outcome;
      try { out = await this.relayer.handle(fs.readFileSync(file, "utf8"), `inbox:${name}`); }
      catch (e: any) { out = { status: "failed", detail: String(e?.message ?? e) }; }
      const dest = out.status === "rejected" || out.status === "unreadable" ? this.rejected : out.status === "failed" ? this.failed : this.done;
      try { fs.renameSync(file, path.join(dest, name)); } catch (e: any) { this.log("inbox.move_failed", { name, error: String(e?.message ?? e) }); }
      this.seen.delete(name);
      this.log("inbox.moved", { name, to: path.basename(dest), status: out.status });
      return out;
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** Poll the directory (fs.watch is unreliable on network/overlay filesystems). */
  start(pollMs: number) { const tick = () => { this.scan().catch(() => undefined); }; tick(); this.timer = setInterval(tick, pollMs); }
  stop() { if (this.timer) clearInterval(this.timer); }
}

/** POST /bundles stores the bundle in the inbox (durable) and returns 202; GET /status, GET /health. */
export function httpServer(inbox: Inbox, state: State, log: Logger, opts: { onAccepted?: () => void } = {}) {
  return http.createServer((req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/health") return send(200, { ok: true });
    if (req.method === "GET" && url.pathname === "/status") {
      const h = url.searchParams.get("statement");
      if (h) { const e = state.get(h); return e ? send(200, e) : send(404, { error: "unknown statement" }); }
      return send(200, { entries: state.all().map(({ statementHash, status, score, updatedAt, claims }) => ({ statementHash, status, score, updatedAt, claims })) });
    }
    if (req.method === "POST" && url.pathname === "/bundles") {
      const chunks: Buffer[] = []; let size = 0; let aborted = false;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BUNDLE_BYTES && !aborted) { aborted = true; send(413, { error: "bundle too large" }); req.destroy(); }
        else chunks.push(c);
      });
      req.on("end", () => {
        if (aborted) return;
        const text = Buffer.concat(chunks).toString("utf8");
        let st: any;
        try { st = JSON.parse(text).statement; } catch { return send(400, { error: "body is not JSON" }); }
        if (!st || typeof st !== "object") return send(400, { error: "no statement in bundle" });
        const id = createHash("sha256").update(text).digest("hex").slice(0, 24);
        const name = `http-${id}.json`;
        const tmp = path.join(inbox.dir, `.${name}.part`);
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, path.join(inbox.dir, name));
        log("http.accepted", { name, bytes: text.length, remote: req.socket.remoteAddress });
        send(202, { accepted: name, status: "/status" });
        opts.onAccepted?.();
      });
      return;
    }
    send(404, { error: "not found" });
  });
}
