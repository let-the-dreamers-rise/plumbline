// The zk guest's journal (SPEC: 298 bytes from sealed-eval-zk, then payout[32] = 330 bytes).
// statement_hash 32 | model_id_hash 32 | suite_commitment 32 | quote_hash 32 | mr_td 48 | rtmrs_hash 32 |
// tee_tcb_svn 16 | root_sha256 32 | correct u32 LE | total u32 LE | binding_version u8 | bound u8 |
// compose_hash 32 | payout 32
export const JOURNAL_LEN = 330;
export const LEGACY_JOURNAL_LEN = 298;

export type Journal = {
  statementHash: Buffer; modelIdHash: Buffer; suiteCommitment: Buffer; quoteHash: Buffer; mrTd: Buffer;
  rtmrsHash: Buffer; teeTcbSvn: Buffer; rootSha256: Buffer; correct: number; total: number;
  bindingVersion: number; bound: number; composeHash: Buffer; payout: Buffer;
};

export function parseJournal(j: Buffer): Journal {
  if (j.length !== JOURNAL_LEN) {
    throw new Error(`journal is ${j.length} bytes, expected ${JOURNAL_LEN}` +
      (j.length === LEGACY_JOURNAL_LEN ? " (this is a pre-payout sealed-eval proof; re-prove with the plumbline guest)" : ""));
  }
  const s = (a: number, n: number) => Buffer.from(j.subarray(a, a + n));
  return {
    statementHash: s(0, 32), modelIdHash: s(32, 32), suiteCommitment: s(64, 32), quoteHash: s(96, 32),
    mrTd: s(128, 48), rtmrsHash: s(176, 32), teeTcbSvn: s(208, 16), rootSha256: s(224, 32),
    correct: j.readUInt32LE(256), total: j.readUInt32LE(260), bindingVersion: j[264], bound: j[265],
    composeHash: s(266, 32), payout: s(298, 32),
  };
}

export type Proof = { imageId: Buffer; journal: Buffer; seal: Buffer };

/** Proof JSON as written by the zk host (`groth16` mode): {imageId, journal, seal} as 0x-hex. */
export function parseProof(p: any): Proof {
  const h = (v: unknown, what: string) => {
    if (typeof v !== "string" || !/^(0x)?[0-9a-fA-F]*$/.test(v)) throw new Error(`proof.${what} is not hex`);
    return Buffer.from(v.replace(/^0x/, ""), "hex");
  };
  const out = { imageId: h(p.imageId, "imageId"), journal: h(p.journal, "journal"), seal: h(p.seal, "seal") };
  if (out.imageId.length !== 32) throw new Error("proof.imageId must be 32 bytes");
  return out;
}
