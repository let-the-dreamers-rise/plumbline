import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_MONITOR_FILE, monitorReply, snapshotReader } from "./monitor.js";

const valid = JSON.stringify({ schema: "plumbline.monitor/v1", generatedAt: "2026-10-12T18:00:00.000Z", loans: [], book: { activeLoans: 0 } });

describe("GET /api/monitor handler", () => {
  it("returns the snapshot as JSON with a short public cache", () => {
    const r = monitorReply(() => valid);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.headers["cache-control"]).toBe("public, max-age=300");
    expect(JSON.parse(r.body).schema).toBe("plumbline.monitor/v1");
  });

  it("serves the committed snapshot", () => {
    const r = monitorReply(snapshotReader(undefined));
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.lender).toBe("USD.AI");
    expect(body.loans.length).toBeGreaterThan(0);
    expect(r.body).toBe(readFileSync(DEFAULT_MONITOR_FILE, "utf8"));
  });

  it("answers 503 when no snapshot exists yet", () => {
    const r = monitorReply(snapshotReader("Z:/no/such/monitor.json"));
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body)).toEqual({ error: "no monitor snapshot yet" });
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("answers 500 without internals for a corrupt or foreign file", () => {
    for (const raw of ["{not json", "null", JSON.stringify({ schema: "other", loans: [] }), JSON.stringify({ schema: "plumbline.monitor/v1" })]) {
      const r = monitorReply(() => raw);
      expect(r.status).toBe(500);
      expect(JSON.parse(r.body)).toEqual({ error: "monitor snapshot is invalid" });
    }
  });

  it("answers 503 for an unreadable file without leaking the error", () => {
    const r = monitorReply(() => {
      throw Object.assign(new Error("EACCES: secret path"), { code: "EACCES" });
    });
    expect(r.status).toBe(503);
    expect(r.body).not.toMatch(/secret/);
  });
});
