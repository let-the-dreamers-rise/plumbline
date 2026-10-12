// Sponsor side: seal a suite to the enclave's key (libsodium sealed box, as tessera_eval.py does with
// PyNaCl's SealedBox) and compute its commitment. Nothing here ever prints or returns suite contents.
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import sodium from "libsodium-wrappers";
// @ts-ignore - plain ES module shared with the web app
import * as tv from "../../app/tessera-verify.js";

export const SEALED_FORMAT = "plumbline-sealed-suite-1";
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest();

export type KeyRelease = { quote: string; event_log: unknown; report_data: string };
export type Attestation = { enclave_pubkey: string; challenge: string; report_data: string; quote: string; event_log?: unknown };
export type SealedSuite = {
  format: typeof SEALED_FORMAT; suite_commitment: string; enclave_pubkey: string; challenge: string | null;
  sealed: string; key_release: KeyRelease | null; quote_checked: "intel" | "binding-only" | "none";
};

/** sha256(canonical(suite)), with canonical() identical to sealed-eval's Python. */
export function suiteCommitment(suiteBytes: Buffer): string {
  let parsed: any;
  try { parsed = tv.pyJsonLoads(new TextDecoder("utf-8", { fatal: true }).decode(suiteBytes)); }
  catch { throw new Error("suite file is not valid UTF-8 JSON"); } // no detail: it could echo contents
  if (!(parsed instanceof Map)) throw new Error("suite file must be a JSON object");
  return sha256(tv.canonical(parsed)).toString("hex");
}

export async function sealTo(pubkeyHex: string, data: Buffer): Promise<string> {
  await sodium.ready;
  const pk = Buffer.from(pubkeyHex, "hex");
  if (!/^[0-9a-f]{64}$/.test(pubkeyHex) || pk.length !== 32) throw new Error("enclave pubkey must be 64 lowercase hex chars (X25519)");
  return Buffer.from(sodium.crypto_box_seal(data, pk)).toString("base64");
}

export const keyReleaseReportData = (pubkeyHex: string, challengeHex: string) =>
  sha256(Buffer.concat([Buffer.from("tessera:keyrelease:v1"), Buffer.from(pubkeyHex, "hex"), Buffer.from(challengeHex, "hex")])).toString("hex");

export const newChallenge = () => randomBytes(32).toString("hex");

/**
 * Check a GET /attest response for `pubkeyHex`: the stated report_data and the quote's report_data must
 * both equal sha256("tessera:keyrelease:v1" || pk || challenge). With intel = true the quote must also
 * verify to Intel's root (a stub quote from a local enclave does not).
 */
export async function checkAttestation(a: Attestation, pubkeyHex: string, challenge: string | null, intel: boolean) {
  if (a.enclave_pubkey !== pubkeyHex) throw new Error("attestation is for a different enclave key than --enclave-pubkey");
  if (challenge && a.challenge !== challenge) throw new Error("attestation answers a different challenge");
  const want = keyReleaseReportData(pubkeyHex, a.challenge);
  if (String(a.report_data).slice(0, 64) !== want) throw new Error("attestation report_data does not bind the enclave key and challenge");
  const q = Buffer.from(a.quote, "hex");
  if (q.length < 48 + 584 || q.subarray(48 + 520, 48 + 552).toString("hex") !== want) {
    throw new Error("key-release quote does not carry the expected report_data");
  }
  if (intel) await tv.verifyQuote(new Uint8Array(q)); // throws with the failing check
}

export async function sealSuite(opts: {
  suitePath: string; enclavePubkey: string; attestation?: Attestation | null; intel?: boolean;
}): Promise<SealedSuite> {
  const bytes = fs.readFileSync(opts.suitePath);
  const commitment = suiteCommitment(bytes);
  const a = opts.attestation ?? null;
  if (a) await checkAttestation(a, opts.enclavePubkey, null, opts.intel ?? true);
  const sealed = await sealTo(opts.enclavePubkey, bytes);
  bytes.fill(0);
  return {
    format: SEALED_FORMAT, suite_commitment: commitment, enclave_pubkey: opts.enclavePubkey, challenge: a?.challenge ?? null,
    sealed, key_release: a ? { quote: a.quote, event_log: a.event_log ?? "[]", report_data: a.report_data } : null,
    quote_checked: a ? (opts.intel ?? true ? "intel" : "binding-only") : "none",
  };
}

export function readSealedSuite(path: string): SealedSuite {
  const s = JSON.parse(fs.readFileSync(path, "utf8"));
  if (s.format !== SEALED_FORMAT) throw new Error(`${path} is not a ${SEALED_FORMAT} file (make one with plumbline seal)`);
  return s;
}
