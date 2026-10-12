// Score bundles: offline checks before spending prover time, prover inputs, payout extraction.
// The canonical JSON and the TDX/event-log logic come from the browser verifier (app/tessera-verify.js),
// so the CLI, the relayer and the web page agree byte for byte with sealed-eval's Python.
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
// @ts-ignore - plain ES module shared with the web app
import * as tv from "../../app/tessera-verify.js";

export const RUNTIME_EVENT_TYPE = 0x08000001;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest();
const sha384 = (b: Uint8Array) => createHash("sha384").update(b).digest();

export type Check = { name: string; ok: boolean; detail?: string };
export type BundleReport = {
  ok: boolean; checks: Check[]; statementHash: string; suiteCommitment: string; correct: number; n: number;
  modelId: string; modelRevision: string; payoutHex: string | null; payout: string | null; composeHash: string | null;
  emptyDigests: number; fullVerify?: { ok: boolean; detail: string; lines?: string[] };
};

export type QuoteCheck = "binding" | "full";

const getMap = (m: any, k: string) => (m instanceof Map ? m.get(k) : m?.[k]);

export function parseBundleText(text: string) {
  const plain = JSON.parse(text);
  const py = tv.pyJsonLoads(text);
  const st = getMap(py, "statement");
  if (!st) throw new Error("bundle has no statement");
  const canonical: Buffer = Buffer.from(tv.canonical(st));
  return { plain, py, canonical };
}

export function payoutFromHex(h: unknown): { hex: string | null; base58: string | null; error?: string } {
  if (h === undefined || h === null) return { hex: null, base58: null, error: "statement has no payout field" };
  if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) return { hex: null, base58: null, error: "payout must be 64 lowercase hex chars" };
  if (/^0+$/.test(h)) return { hex: h, base58: null, error: "payout is all zero (the escrow refuses to pay it)" };
  return { hex: h, base58: new PublicKey(Buffer.from(h, "hex")).toBase58() };
}

export function payoutToHex(pubkey: string): string {
  const pk = new PublicKey(pubkey); // throws on a malformed key
  if (pk.equals(PublicKey.default)) throw new Error("payout must not be the all-zero key");
  return pk.toBuffer().toString("hex");
}

export function eventLogArray(log: unknown): any[] {
  if (log === undefined || log === null || log === "") return [];
  const v = typeof log === "string" ? JSON.parse(log) : log;
  if (!Array.isArray(v)) throw new Error("event_log is not a JSON array");
  return v;
}

export const runtimeDigest = (e: any) =>
  sha384(Buffer.concat([u32le(RUNTIME_EVENT_TYPE), Buffer.from(":"), Buffer.from(String(e.event), "utf8"), Buffer.from(":"),
    Buffer.from(e.event_payload || "", "hex")])).toString("hex");
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

/**
 * dstack-cloud strips the digests of runtime (RTMR3) events. The plumbline guest recomputes them
 * (SPEC "also folded in"); do the same before handing the log to the unchanged browser verifier.
 * Returns the log in the same form it came in (string stays string) and how many digests were filled.
 */
export function fillEmptyDigests(log: unknown): { log: unknown; filled: number } {
  if (log === undefined || log === null) return { log, filled: 0 };
  const arr = eventLogArray(log);
  let filled = 0;
  const out = arr.map((e) => {
    if (e && e.imr === 3 && e.event_type === RUNTIME_EVENT_TYPE && !e.digest) { filled++; return { ...e, digest: runtimeDigest(e) }; }
    return e;
  });
  if (!filled) return { log, filled: 0 };
  return { log: typeof log === "string" ? JSON.stringify(out) : out, filled };
}

/** TDX v4 quote: 48-byte header, report_data at TD report body offset 520. */
export const quoteReportData = (q: Buffer) => q.subarray(48 + 520, 48 + 520 + 64);

/**
 * Offline checks (bundle_to_inputs.py, plus the payout field). With quoteCheck = "full" it also runs the
 * browser verifier's verifyBundle (Intel chain, both quotes, RTMR3 replay); stub/synthetic quotes fail that.
 */
export async function checkBundle(text: string, opts: { quoteCheck?: QuoteCheck } = {}): Promise<BundleReport> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => { checks.push({ name, ok, detail }); return ok; };
  const { plain, canonical } = parseBundleText(text);
  const st = plain.statement ?? {};
  const statementHash = sha256(canonical).toString("hex");
  add("statement_sha256 is the hash of the canonical statement", statementHash === plain.statement_sha256,
    statementHash === plain.statement_sha256 ? undefined : `computed ${statementHash}, bundle says ${plain.statement_sha256}`);
  add("statement is tessera-score-1", st.v === "tessera-score-1", `v = ${st.v}`);

  const pay = payoutFromHex(st.payout);
  add("statement carries a non-zero payout", !pay.error && !!pay.base58, pay.error);

  const score = plain.score ?? {};
  let quote = Buffer.alloc(0);
  try { quote = Buffer.from(String(score.quote ?? ""), "hex"); } catch { /* reported below */ }
  const want = sha256(Buffer.concat([Buffer.from("tessera:score:v1"), canonical]));
  const rd = quote.length >= 48 + 584 ? quoteReportData(quote) : Buffer.alloc(0);
  add("score quote report_data binds the statement", rd.length === 64 && rd.subarray(0, 32).equals(want),
    rd.length ? undefined : "score quote missing or too short");

  let events: any[] = [];
  try { events = eventLogArray(score.event_log).filter((e) => e && e.imr === 3); }
  catch (e: any) { add("score event log parses", false, String(e.message ?? e)); }
  const bad: string[] = [], compose: string[] = [];
  let empty = 0;
  for (const e of events) {
    if (e.event_type !== RUNTIME_EVENT_TYPE) {
      if (Buffer.from(e.digest || "", "hex").length !== 48) bad.push(String(e.event));
      continue;
    }
    if (!e.digest) empty++;
    else if (e.digest !== runtimeDigest(e)) bad.push(String(e.event));
    if (e.event === "compose-hash") compose.push(String(e.event_payload || ""));
  }
  add("RTMR3 runtime event digests recompute (empty = stripped by dstack-cloud, recomputed)", bad.length === 0,
    bad.length ? `bad: ${bad.join(", ")}` : `${events.length} events, ${empty} stripped`);
  const composeOk = compose.length === 1 && Buffer.from(compose[0], "hex").length === 32;
  add("exactly one 32-byte compose-hash event", composeOk, `found ${compose.length}`);

  let fullVerify: BundleReport["fullVerify"];
  if (opts.quoteCheck === "full") {
    try {
      const b = JSON.parse(text);
      for (const part of ["score", "key_release"]) if (b[part]) b[part].event_log = fillEmptyDigests(b[part].event_log).log;
      // verifyBundle wants the Python-faithful parse of the whole bundle; re-serialise after filling digests,
      // keeping the original statement text so canonical() is unaffected.
      const r = await tv.verifyBundle(spliceStatement(JSON.stringify(b), text));
      fullVerify = { ok: true, detail: "Intel chain, both quotes bound, RTMR3 replayed, same enclave", lines: r.lines };
    } catch (e: any) {
      fullVerify = { ok: false, detail: `${e?.name ?? "Error"}: ${e?.message ?? e}` };
    }
    add("full quote verification (Intel root, key release + score)", fullVerify.ok, fullVerify.detail);
  }

  return {
    ok: checks.every((c) => c.ok), checks, statementHash, suiteCommitment: String(st.suite_commitment ?? ""),
    correct: Number(st.correct), n: Number(st.n), modelId: String(st.model_id ?? ""), modelRevision: String(st.model_revision ?? ""),
    payoutHex: pay.hex, payout: pay.base58, composeHash: composeOk ? compose[0] : null, emptyDigests: empty, fullVerify,
  };
}

/** Put the statement's original JSON text back into a re-serialised bundle (exact numbers survive). */
function spliceStatement(reserialised: string, original: string): string {
  const py = tv.pyJsonLoads(original);
  const stText = new TextDecoder().decode(tv.canonical(getMap(py, "statement")));
  const obj = JSON.parse(reserialised);
  const marker = "__PLUMBLINE_STATEMENT__";
  obj.statement = marker;
  return JSON.stringify(obj).replace(JSON.stringify(marker), stText);
}

/** The guest's three inputs, exactly as tools/bundle_to_inputs.py writes them. */
export function proverInputs(text: string) {
  const { plain, canonical } = parseBundleText(text);
  const log = plain.score?.event_log ?? "[]";
  return {
    quote: Buffer.from(String(plain.score?.quote ?? ""), "hex"),
    statement: canonical,
    eventLog: typeof log === "string" ? log : JSON.stringify(log),
  };
}
