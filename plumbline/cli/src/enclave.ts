// Competition-mode enclave HTTP API (plumbline/enclave): GET /attest, POST /enter.
import { createHash } from "node:crypto";
import type { Attestation, SealedSuite } from "./seal.js";
import { parseBundleText } from "./bundle.js";

export type Shard = { file?: string; url?: string; sha256: string; size?: number };
export type EnterRequest = {
  challenge: string; sealed: string; model_id: string; revision: string; weights: Shard[]; payout: string;
  dtype?: "bfloat16" | "float32"; weights_sha256?: string;
};
export type EnterResponse = { statement: Record<string, unknown>; quote: string; event_log: unknown; report_data: string };

const ERRORS: Record<number, string> = {
  400: "bad request or disallowed weights host", 409: "enclave is busy with another entry", 413: "request or weights too big",
  422: "a check failed (weights sha256, architecture or config)", 502: "the enclave could not fetch the weights",
  500: "the enclave failed after decrypting the suite",
};

async function call(url: string, init?: RequestInit, timeoutMs = 3_600_000): Promise<any> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text).error ?? msg; } catch { /* keep text */ }
    throw new Error(`enclave ${r.status} (${ERRORS[r.status] ?? "error"}): ${msg}`);
  }
  return text;
}

const base = (u: string) => u.replace(/\/+$/, "");

export async function attest(enclaveUrl: string, challenge: string): Promise<Attestation> {
  return JSON.parse(await call(`${base(enclaveUrl)}/attest?challenge=${challenge}`, undefined, 120_000));
}

/** POST /enter; returns the raw response text so the statement's exact JSON is kept. */
export async function enter(enclaveUrl: string, req: EnterRequest): Promise<string> {
  return call(`${base(enclaveUrl)}/enter`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req),
  });
}

/**
 * bundle = {statement, statement_sha256, key_release (the sponsor's published one), score:{quote,event_log,report_data}}.
 * Built by text splicing so the statement keeps the enclave's exact JSON (numbers included).
 */
export function assembleBundle(responseText: string, sealed: SealedSuite): string {
  const resp = JSON.parse(responseText) as EnterResponse;
  if (!resp.statement || !resp.quote) throw new Error("enclave response has no statement/quote");
  const { canonical } = parseBundleText(responseText);
  const statementSha = createHash("sha256").update(canonical).digest("hex");
  const rest = {
    statement_sha256: statementSha,
    key_release: sealed.key_release,
    score: { quote: resp.quote, event_log: resp.event_log, report_data: resp.report_data },
    challenge_source: { source: "sponsor-attest", challenge: sealed.challenge },
  };
  const tail = JSON.stringify(rest, null, 1).slice(1); // drop the leading "{"
  return `{"statement": ${new TextDecoder().decode(canonical)},${tail}`;
}
