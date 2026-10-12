// Account layouts for the browser (no Anchor here). Mirrors cli/src/chain (which decodes with the IDL);
// cli/test/layout.test.ts checks this decoder against Anchor's coder byte for byte.

export const DISC = {
  Bounty: [237, 16, 105, 198, 19, 69, 242, 234],
  VerifiedScore: [191, 249, 181, 148, 69, 3, 1, 222],
  Suite: [121, 38, 87, 202, 248, 217, 33, 123],
};
/** Byte offsets (after the 8-byte discriminator) used for getProgramAccounts memcmp filters. */
export const OFFSETS = { bountySuite: 8 + 32 + 8, scoreStatement: 8, scoreSuite: 8 + 64 };

// ---------- base58 ----------
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(bytes) {
  let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ''; while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  return '1'.repeat(zeros) + s;
}
export function b58decode(str) {
  let n = 0n;
  for (const c of str) { const i = ALPHABET.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of str) { if (c !== '1') break; out.unshift(0); }
  return Uint8Array.from(out);
}
export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const fromHex = (h) => Uint8Array.from((h.match(/../g) || []).map((x) => parseInt(x, 16)));
export const ZERO_KEY = '11111111111111111111111111111111';
export const ZERO32 = '0'.repeat(64);

export function b64decode(s) {
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class Reader {
  constructor(bytes) { this.b = bytes; this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.o = 0; }
  need(n) { if (this.o + n > this.b.length) throw new Error('account data too short'); }
  bytes(n) { this.need(n); const r = this.b.slice(this.o, this.o + n); this.o += n; return r; }
  hex(n) { return hex(this.bytes(n)); }
  key() { return b58encode(this.bytes(32)); }
  u8() { this.need(1); return this.b[this.o++]; }
  bool() { return this.u8() !== 0; }
  u32() { this.need(4); const x = this.v.getUint32(this.o, true); this.o += 4; return x; }
  u64() { this.need(8); const x = this.v.getBigUint64(this.o, true); this.o += 8; return x; }
  i64() { this.need(8); const x = this.v.getBigInt64(this.o, true); this.o += 8; return x; }
  optKey() { return this.u8() ? this.key() : null; }
}

function checkDisc(data, name) {
  const d = DISC[name];
  for (let i = 0; i < 8; i++) if (data[i] !== d[i]) throw new Error(`not a ${name} account`);
  return new Reader(data.subarray(8));
}

export function decodeBounty(address, data, lamports) {
  const r = checkDisc(data, 'Bounty');
  const b = {
    address, sponsor: r.key(), nonce: r.u64(), suiteCommitment: r.hex(32), minCorrect: r.u32(), minTotal: r.u32(), amount: r.u64(),
    mint: r.optKey(), deadlineSlot: r.u64(), claimGraceSlots: r.u64(), requireRegisteredSuite: r.bool(), requiredComposeHash: r.hex(32),
    requiredImageId: r.hex(32), createdSlot: r.u64(), status: r.u8() === 0 ? 'open' : 'paid', winnerStatementHash: r.hex(32),
    winnerModelIdHash: r.hex(32), winnerPayout: r.key(), paidSlot: r.u64(),
  };
  if (lamports !== undefined) b.lamports = lamports;
  return b;
}

export function decodeScore(address, data) {
  const r = checkDisc(data, 'VerifiedScore');
  return {
    address, statementHash: r.hex(32), modelIdHash: r.hex(32), suiteCommitment: r.hex(32), quoteHash: r.hex(32), mrTd: r.hex(48),
    rtmrsHash: r.hex(32), teeTcbSvn: r.hex(16), composeHash: r.hex(32), correct: r.u32(), total: r.u32(), bindingVersion: r.u8(),
    imageId: r.hex(32), suiteRegistered: r.bool(), submitter: r.key(), slot: r.u64(), unixTimestamp: r.i64(), payout: r.key(),
  };
}

export function meetsTarget(correct, total, minCorrect, minTotal) {
  return total >= minTotal && BigInt(correct) * BigInt(minTotal) >= BigInt(minCorrect) * BigInt(total);
}

/** Same checks, same order, as the bounty program's claim (and cli/src/chain claimable). */
export function claimable(b, s) {
  if (b.status !== 'open') return 'AlreadyPaid';
  if (b.suiteCommitment !== s.suiteCommitment) return 'WrongSuite';
  if (b.requiredComposeHash !== ZERO32 && b.requiredComposeHash !== s.composeHash) return 'WrongEnclave';
  if (b.requiredImageId !== ZERO32 && b.requiredImageId !== s.imageId) return 'WrongEnclave';
  if (!meetsTarget(s.correct, s.total, b.minCorrect, b.minTotal)) return 'BelowTarget';
  if (s.slot > b.deadlineSlot) return 'ScoreAfterDeadline';
  if (s.slot < b.createdSlot) return 'ScoreBeforeBounty';
  if (s.payout === ZERO_KEY) return 'NoPayout';
  return null;
}

/** Higher accuracy first (cross-multiplied), earlier slot first on ties. */
export function rank(a, b) {
  const d = b.correct * a.total - a.correct * b.total;
  return d !== 0 ? d : (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0);
}

export const REASONS = {
  AlreadyPaid: 'bounty already paid', WrongSuite: 'different suite', WrongEnclave: 'different enclave or guest image',
  BelowTarget: 'below target', ScoreAfterDeadline: 'recorded after the deadline', ScoreBeforeBounty: 'recorded before the bounty existed',
  NoPayout: 'no payout in the statement',
};
