// Synthetic bundles for tests: a quote-shaped byte string whose report_data binds the statement, and an
// event log with one runtime compose-hash event. They pass the binding checks and fail the Intel check.
import { createHash, randomBytes } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
// @ts-ignore
import * as tv from "../../app/tessera-verify.js";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest();
const RT = 0x08000001;

export function fakeQuote(reportData32: Buffer): Buffer {
  const q = Buffer.alloc(48 + 584 + 4 + 64);
  q.writeUInt16LE(4, 0); q.writeUInt16LE(2, 2); q.writeUInt32LE(0x81, 4);
  reportData32.copy(q, 48 + 520);
  return q;
}

export function runtimeEvent(event: string, payloadHex: string, stripDigest = false) {
  const t = Buffer.alloc(4); t.writeUInt32LE(RT);
  const digest = createHash("sha384").update(Buffer.concat([t, Buffer.from(":"), Buffer.from(event), Buffer.from(":"), Buffer.from(payloadHex, "hex")])).digest("hex");
  return { imr: 3, event_type: RT, digest: stripDigest ? "" : digest, event, event_payload: payloadHex };
}

export type BundleOpts = { payout?: string | null; correct?: number; n?: number; suite?: string; strip?: boolean; model?: string; breakBinding?: boolean; extra?: Record<string, unknown> };

export function makeBundle(o: BundleOpts = {}) {
  const payoutPk = o.payout === undefined ? Keypair.generate().publicKey.toBase58() : o.payout;
  const statement: Record<string, unknown> = {
    v: "tessera-score-1", suite_id: "test-suite-0001", suite_commitment: o.suite ?? "7c".repeat(32), n: o.n ?? 6, correct: o.correct ?? 4,
    marks_sha256: "00".repeat(32), model_id: o.model ?? "org/tiny-model", model_revision: "ab".repeat(20), weights_sha256: "cd".repeat(32),
    challenge: "e6".repeat(32), enclave_pubkey: "0a".repeat(32), ...(o.extra ?? {}),
  };
  if (payoutPk) statement.payout = new PublicKey(payoutPk).toBuffer().toString("hex");
  const canonical = Buffer.from(tv.canonical(tv.pyJsonLoads(JSON.stringify(statement))));
  const bind = sha256(Buffer.concat([Buffer.from("tessera:score:v1"), canonical]));
  if (o.breakBinding) bind[0] ^= 1;
  const compose = randomBytes(32).toString("hex");
  const log = JSON.stringify([runtimeEvent("system-ready", ""), runtimeEvent("compose-hash", compose, o.strip)]);
  const krRd = sha256(Buffer.concat([Buffer.from("tessera:keyrelease:v1"), Buffer.from(statement.enclave_pubkey as string, "hex"), Buffer.from(statement.challenge as string, "hex")]));
  const bundle = {
    statement, statement_sha256: sha256(canonical).toString("hex"),
    key_release: { quote: fakeQuote(krRd).toString("hex"), event_log: log, report_data: krRd.toString("hex") + "00".repeat(32) },
    score: { quote: fakeQuote(bind).toString("hex"), event_log: log, report_data: bind.toString("hex") + "00".repeat(32) },
  };
  return { bundle, text: JSON.stringify(bundle), statementHash: bundle.statement_sha256, payout: payoutPk, compose, canonical };
}

/** A 330-byte journal matching a bundle (what the zk host would prove). */
export function journalFor(b: ReturnType<typeof makeBundle>, over: { bound?: number; payoutHex?: string } = {}) {
  const j = Buffer.alloc(330);
  const st: any = b.bundle.statement;
  Buffer.from(b.statementHash, "hex").copy(j, 0);
  Buffer.from(st.suite_commitment, "hex").copy(j, 64);
  j.writeUInt32LE(st.correct, 256); j.writeUInt32LE(st.n, 260);
  j[264] = 1; j[265] = over.bound ?? 1;
  Buffer.from(b.compose, "hex").copy(j, 266);
  Buffer.from(over.payoutHex ?? st.payout ?? "00".repeat(32), "hex").copy(j, 298);
  return j;
}

export function proofJsonFor(b: ReturnType<typeof makeBundle>, over: Parameters<typeof journalFor>[1] = {}) {
  return { imageId: "0x" + "11".repeat(32), journal: "0x" + journalFor(b, over).toString("hex"), seal: "0x" + "22".repeat(256), claimDigest: "0x" + "33".repeat(32) };
}
