// Relayer state: one JSON file, rewritten atomically after every step, keyed by statement hash.
import * as fs from "node:fs";
import * as path from "node:path";

export type Status = "received" | "rejected" | "proving" | "proved" | "recorded" | "claimed" | "failed";
export type ClaimEntry = { signature?: string; payout?: string; amount?: string; skipped?: string; error?: string; at: string };
export type Entry = {
  statementHash: string; status: Status; source: string; suiteCommitment?: string; payout?: string | null;
  correct?: number; n?: number; proofPath?: string; score?: string; recordTx?: string;
  claims: Record<string, ClaimEntry>; error?: string; attempts: number; firstSeen: string; updatedAt: string;
};
export type StateFile = { version: 1; entries: Record<string, Entry> };

export class State {
  private data: StateFile;
  constructor(readonly file: string) {
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { version: 1, entries: {} };
    if (this.data.version !== 1 || typeof this.data.entries !== "object") throw new Error(`${file}: not a relayer state file`);
  }
  get(h: string): Entry | undefined { return this.data.entries[h]; }
  all(): Entry[] { return Object.values(this.data.entries); }
  upsert(h: string, patch: Partial<Entry> & { source?: string }): Entry {
    const now = new Date().toISOString();
    const prev = this.data.entries[h] ?? { statementHash: h, status: "received", source: patch.source ?? "?", claims: {}, attempts: 0, firstSeen: now, updatedAt: now };
    const next = { ...prev, ...patch, claims: { ...prev.claims, ...(patch.claims ?? {}) }, updatedAt: now } as Entry;
    this.data.entries[h] = next;
    this.save();
    return next;
  }
  private save() {
    fs.mkdirSync(path.dirname(path.resolve(this.file)), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }
}
