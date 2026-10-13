// Tessera sealed-eval bundle verifier for the browser (and Node 20+). No dependencies, no network.
// A line-by-line port of sealed-eval/verify_bundle.py, tdxq.py and gpuq.py: same checks, same order,
// same failure messages. WebCrypto does the hashing and the ECDSA checks.
//
// Checks: both Intel TDX v4 quotes (PCK chain to the pinned Intel SGX Root CA, QE report signed by the
// PCK leaf, attestation key bound to the QE report, quote signed by the attestation key); each quote's
// report_data binds its statement; each event log replays to RTMR3; both quotes come from the same
// measured enclave; statement_sha256 is the hash of the canonical statement. GPU (v2) bundles also get
// the NVIDIA SPDM report and its 5-cert P-384 chain to NVIDIA's pinned Device Identity CA, with the
// requester nonce equal to the statement digest.
// Not checked, as in the Python verifier: Intel TCB info, QE identity, CRLs; NVIDIA RIMs and OCSP.
//
// To match Python exactly, bundles are parsed with a JSON reader that follows Python's json module
// (ints stay exact, floats print as Python's repr), PEM follows the Rust pem crate that pyca/cryptography
// uses, and base64 is strict (canonical padding, no stray bits).

const subtle = globalThis.crypto.subtle;

export const INTEL_ROOT_SHA256 = '44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3'; // Intel SGX Root CA
export const NVIDIA_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICCzCCAZCgAwIBAgIQLTZwscoQBBHB/sDoKgZbVDAKBggqhkjOPQQDAzA1MSIw
IAYDVQQDDBlOVklESUEgRGV2aWNlIElkZW50aXR5IENBMQ8wDQYDVQQKDAZOVklE
SUEwIBcNMjExMTA1MDAwMDAwWhgPOTk5OTEyMzEyMzU5NTlaMDUxIjAgBgNVBAMM
GU5WSURJQSBEZXZpY2UgSWRlbnRpdHkgQ0ExDzANBgNVBAoMBk5WSURJQTB2MBAG
ByqGSM49AgEGBSuBBAAiA2IABA5MFKM7+KViZljbQSlgfky/RRnEQScW9NDZF8SX
gAW96r6u/Ve8ZggtcYpPi2BS4VFu6KfEIrhN6FcHG7WP05W+oM+hxj7nyA1r1jkB
2Ry70YfThX3Ba1zOryOP+MJ9vaNjMGEwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8B
Af8EBAMCAQYwHQYDVR0OBBYEFFeF/4PyY8xlfWi3Olv0jUrL+0lfMB8GA1UdIwQY
MBaAFFeF/4PyY8xlfWi3Olv0jUrL+0lfMAoGCCqGSM49BAMDA2kAMGYCMQCPeFM3
TASsKQVaT+8S0sO9u97PVGCpE9d/I42IT7k3UUOLSR/qvJynVOD1vQKVXf0CMQC+
EY55WYoDBvs2wPAH1Gw4LbcwUN8QCff8bFmV4ZxjCRr4WXTLFHBKjbfneGSBWwA=
-----END CERTIFICATE-----
`;

// ---------- errors: AssertionError (a named check failed), InvalidSignature, FormatError (anything else) ----------
export class VerifyError extends Error { constructor(m = '') { super(m); this.name = 'AssertionError'; } }
export class SignatureError extends Error { constructor(m = '') { super(m); this.name = 'InvalidSignature'; } }
export class FormatError extends Error { constructor(m = '') { super(m); this.name = 'FormatError'; } }
const ok = (cond, msg = '') => { if (!cond) throw new VerifyError(msg); };
const bad = msg => { throw new FormatError(msg); };

// ---------- bytes ----------
const te = new TextEncoder();
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
export const toHex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const eqBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const PY_SPACE = ' \t\n\r\v\f';
const hexVal = c => {
  if (c === undefined) return -1;
  const k = c.charCodeAt(0);
  if (k >= 48 && k <= 57) return k - 48;
  if (k >= 97 && k <= 102) return k - 87;
  if (k >= 65 && k <= 70) return k - 55;
  return -1;
};
// bytes.fromhex: ASCII whitespace allowed between byte pairs, not inside one
export function fromHex(s) {
  if (typeof s !== 'string') bad('fromhex() argument must be str');
  const out = [];
  for (let i = 0; i < s.length;) {
    if (PY_SPACE.includes(s[i])) { i++; continue; }
    const a = hexVal(s[i]), b = hexVal(s[i + 1]);
    if (a < 0 || b < 0) bad(`non-hexadecimal number found in fromhex() arg at position ${i}`);
    out.push(a * 16 + b); i += 2;
  }
  return Uint8Array.from(out);
}
const u16 = (b, o) => { if (o + 2 > b.length) bad(`unpack_from requires a buffer of at least ${o + 2} bytes`); return b[o] | (b[o + 1] << 8); };
const u32 = (b, o) => { if (o + 4 > b.length) bad(`unpack_from requires a buffer of at least ${o + 4} bytes`); return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000; };
const at = (b, i) => { if (i >= b.length) bad('index out of range'); return b[i]; };
const isWellFormed = s => (s.isWellFormed ? s.isWellFormed() : !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s));
const utf8 = s => { if (!isWellFormed(s)) bad("'utf-8' codec can't encode a lone surrogate"); return te.encode(s); };
const digest = async (alg, data) => new Uint8Array(await subtle.digest(alg, data));
const sha256 = d => digest('SHA-256', d);
const sha384 = d => digest('SHA-384', d);

// ---------- Python json semantics ----------
// dict -> Map (insertion order, last value wins), list -> Array, str -> string,
// int -> PyInt (BigInt), float -> PyFloat, true/false -> boolean, null -> null.
export class PyInt { constructor(v) { this.v = v; } }
export class PyFloat { constructor(v) { this.v = v; } }

export function pyJsonLoads(s) {
  if (typeof s !== 'string') bad('the JSON object must be str');
  let i = 0;
  const err = m => bad(`JSON: ${m} at char ${i}`);
  const ws = () => { while (i < s.length && ' \t\n\r'.includes(s[i])) i++; };
  const str = () => {
    i++; let out = '';
    for (;;) {
      if (i >= s.length) err('Unterminated string');
      const c = s[i];
      if (c === '"') { i++; return out; }
      if (c === '\\') {
        const e = s[i + 1];
        const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[e];
        if (simple !== undefined) { out += simple; i += 2; continue; }
        if (e !== 'u') err('Invalid \\escape');
        const h = s.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(h)) err('Invalid \\uXXXX escape');
        out += String.fromCharCode(parseInt(h, 16)); i += 6; continue;
      }
      if (c.charCodeAt(0) < 0x20) err('Invalid control character');
      out += c; i++;
    }
  };
  const num = () => {
    const m = /^(-?(?:0|[1-9]\d*))(\.\d+)?([eE][-+]?\d+)?/.exec(s.slice(i));
    if (!m) err('Expecting value');
    i += m[0].length;
    if (m[2] || m[3]) return new PyFloat(Number(m[0]));
    if (m[1].replace('-', '').length > 4300) err('Exceeds the limit (4300 digits) for integer string conversion');
    return new PyInt(BigInt(m[1]));
  };
  const val = () => {
    const c = s[i];
    if (c === '"') return str();
    if (c === '{') {
      i++; const m = new Map(); ws();
      if (s[i] === '}') { i++; return m; }
      for (;;) {
        if (s[i] !== '"') err('Expecting property name enclosed in double quotes');
        const k = str(); ws();
        if (s[i] !== ':') err("Expecting ':' delimiter");
        i++; ws();
        m.set(k, val()); ws();
        if (s[i] === '}') { i++; return m; }
        if (s[i] !== ',') err("Expecting ',' delimiter");
        i++; ws();
      }
    }
    if (c === '[') {
      i++; const a = []; ws();
      if (s[i] === ']') { i++; return a; }
      for (;;) {
        a.push(val()); ws();
        if (s[i] === ']') { i++; return a; }
        if (s[i] !== ',') err("Expecting ',' delimiter");
        i++; ws();
      }
    }
    for (const [lit, v] of [['null', null], ['true', true], ['false', false], ['NaN', new PyFloat(NaN)],
      ['Infinity', new PyFloat(Infinity)], ['-Infinity', new PyFloat(-Infinity)]]) {
      if (s.startsWith(lit, i)) { i += lit.length; return v; }
    }
    if (c === '-' || (c >= '0' && c <= '9')) return num();
    return err('Expecting value');
  };
  ws();
  const v = val();
  ws();
  if (i !== s.length) err('Extra data');
  return v;
}

export function pyFloatRepr(x) {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const [mant, ex] = Math.abs(x).toExponential().split('e');
  const d = mant.replace('.', ''), decpt = parseInt(ex, 10) + 1;
  let r;
  if (decpt > 16 || decpt <= -4) {
    const e = decpt - 1;
    r = d[0] + (d.length > 1 ? '.' + d.slice(1) : '') + 'e' + (e < 0 ? '-' : '+') + String(Math.abs(e)).padStart(2, '0');
  } else if (decpt <= 0) r = '0.' + '0'.repeat(-decpt) + d;
  else if (decpt >= d.length) r = d + '0'.repeat(decpt - d.length) + '.0';
  else r = d.slice(0, decpt) + '.' + d.slice(decpt);
  return (x < 0 ? '-' : '') + r;
}

const cpCompare = (a, b) => {
  const A = Array.from(a, c => c.codePointAt(0)), B = Array.from(b, c => c.codePointAt(0));
  for (let k = 0; k < Math.min(A.length, B.length); k++) if (A[k] !== B[k]) return A[k] - B[k];
  return A.length - B.length;
};
const jsonStr = s => '"' + s.replace(/[\x00-\x1f\\"]/g, c => ({ '\\': '\\\\', '"': '\\"', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' }[c]
  || '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))) + '"';
// json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
export function pyJsonDumps(o) {
  if (o === null) return 'null';
  if (o === true) return 'true';
  if (o === false) return 'false';
  if (o instanceof PyInt) return o.v.toString();
  if (o instanceof PyFloat) return pyFloatRepr(o.v);
  if (typeof o === 'string') return jsonStr(o);
  if (Array.isArray(o)) return '[' + o.map(pyJsonDumps).join(',') + ']';
  if (o instanceof Map) return '{' + [...o.keys()].sort(cpCompare).map(k => jsonStr(k) + ':' + pyJsonDumps(o.get(k))).join(',') + '}';
  return bad('Object is not JSON serializable');
}
export const canonical = obj => utf8(pyJsonDumps(obj));

// Python dict access helpers (KeyError / TypeError / AttributeError all become FormatError)
const item = (o, k) => {
  if (o instanceof Map) { if (!o.has(k)) bad(`KeyError: '${k}'`); return o.get(k); }
  return bad(`TypeError: cannot index ${pyType(o)} with '${k}'`);
};
const get = (o, k, dflt = null) => {
  if (!(o instanceof Map)) bad(`AttributeError: '${pyType(o)}' object has no attribute 'get'`);
  return o.has(k) ? o.get(k) : dflt;
};
const pyType = o => o === null ? 'NoneType' : typeof o === 'boolean' ? 'bool' : typeof o === 'string' ? 'str' : Array.isArray(o) ? 'list'
  : o instanceof Map ? 'dict' : o instanceof PyInt ? 'int' : o instanceof PyFloat ? 'float' : typeof o;
const pyEqNum = (a, n) => (a instanceof PyInt && a.v === BigInt(n)) || (a instanceof PyFloat && a.v === n) || (a === true && n === 1) || (a === false && n === 0);
const pyIter = o => {
  if (Array.isArray(o)) return o;
  if (o instanceof Map) return [...o.keys()];
  if (typeof o === 'string') return Array.from(o);
  return bad(`TypeError: '${pyType(o)}' object is not iterable`);
};
const pyRepr = o => {
  if (typeof o === 'string') return "'" + o.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  if (Array.isArray(o)) return '[' + o.map(pyRepr).join(', ') + ']';
  if (o instanceof Map) return '{' + [...o].map(([k, v]) => pyRepr(k) + ': ' + pyRepr(v)).join(', ') + '}';
  return pyStr(o);
};
const pyStr = o => o === null || o === undefined ? 'None' : o === true ? 'True' : o === false ? 'False' : typeof o === 'string' ? o
  : o instanceof PyInt ? o.v.toString() : o instanceof PyFloat ? pyFloatRepr(o.v) : pyRepr(o);
const pyHead = (o, n) => {
  if (typeof o === 'string') return Array.from(o).slice(0, n).join('');
  if (Array.isArray(o)) return pyRepr(o.slice(0, n));
  return bad(`TypeError: '${pyType(o)}' object is not subscriptable`);
};

// ---------- DER / X.509 (just what the two verifiers use) ----------
function derNext(b, o) {
  if (o + 1 > b.length) bad('DER: truncated');
  let tag = b[o], p = o + 1;
  if ((tag & 0x1f) === 0x1f) { // long-form tag number, minimal base128, at least 31
    let v = 0, first = true;
    for (;;) {
      if (p >= b.length) bad('DER: truncated');
      const x = b[p++];
      if (first && x === 0x80) bad('DER: invalid tag');
      first = false;
      v = v * 128 + (x & 0x7f);
      if (v > 0xffffffff) bad('DER: invalid tag');
      if (!(x & 0x80)) break;
    }
    if (v < 0x1f) bad('DER: invalid tag');
    tag = 0x10000 * (tag & 0xe0) + 0x100 + v; // never equal to a one-byte tag
  }
  if (p + 1 > b.length) bad('DER: truncated');
  let len = b[p++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || p + n > b.length) bad('DER: bad length');
    if (b[p] === 0) bad('DER: non-minimal length');
    len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + b[p + k];
    if (len < 128) bad('DER: non-minimal length');
    p += n;
  }
  if (p + len > b.length) bad('DER: truncated');
  return { tag, raw: b.subarray(o, p + len), c: b.subarray(p, p + len), end: p + len };
}
function derAll(b) {
  const out = [];
  for (let o = 0; o < b.length;) { const e = derNext(b, o); out.push(e); o = e.end; }
  return out;
}
const derOne = (b, tag) => {
  const a = derAll(b);
  if (a.length !== 1 || a[0].tag !== tag) bad('DER: unexpected structure');
  return a[0];
};
// a SEQUENCE's fields, in order, with optional ones: spec = [[tag, optional], ...]; nothing may be left over
function derFields(c, spec) {
  const a = derAll(c), out = [];
  let i = 0;
  for (const [tag, optional] of spec) {
    if (a[i] && a[i].tag === tag) out.push(a[i++]);
    else if (optional) out.push(null);
    else bad(`DER: expected tag 0x${tag.toString(16)}`);
  }
  if (i !== a.length) bad('DER: extra data');
  return out;
}
const derBool = e => {
  if (e.c.length !== 1 || (e.c[0] !== 0 && e.c[0] !== 0xff)) bad('DER: bad BOOLEAN');
  return e.c[0] === 0xff;
};
const derIntOk = e => { if (!e.c.length || (e.c.length > 1 && ((e.c[0] === 0 && !(e.c[1] & 0x80)) || (e.c[0] === 0xff && (e.c[1] & 0x80))))) bad('DER: non-minimal INTEGER'); return e; };
function oidStr(c) {
  if (!c.length || c.length > 63 || (c[c.length - 1] & 0x80)) bad('DER: bad OID');
  const out = [];
  let v = 0, first = true;
  for (const x of c) {
    if (first && x === 0x80) bad('DER: non-minimal OID arc');
    first = false;
    v = v * 128 + (x & 0x7f);
    if (!(x & 0x80)) { out.push(v); v = 0; first = true; }
  }
  const f = out.shift();
  return [f < 40 ? 0 : f < 80 ? 1 : 2, f < 80 ? f % 40 : f - 80, ...out].join('.');
}
const OID = {
  ecPublicKey: '1.2.840.10045.2.1', p256: '1.2.840.10045.3.1.7', p384: '1.3.132.0.34', p521: '1.3.132.0.35',
  basicConstraints: '2.5.29.19', keyUsage: '2.5.29.15', tcbInfo: '2.23.133.5.4.1', serialNumber: '2.5.4.5',
};
const CURVES = { [OID.p256]: ['P-256', 32], [OID.p384]: ['P-384', 48], [OID.p521]: ['P-521', 66] };
// key types and curves pyca/cryptography can load; anything else fails to load there ("Unknown key type")
const KNOWN_KEYS = new Set([OID.ecPublicKey, '1.2.840.113549.1.1.1', '1.2.840.113549.1.1.10', '1.3.101.110', '1.3.101.111', '1.3.101.112',
  '1.3.101.113', '1.2.840.10040.4.1', '1.2.840.10046.2.1', '1.2.840.113549.1.3.1']);
const KNOWN_CURVES = new Set([OID.p256, OID.p384, OID.p521, '1.2.840.10045.3.1.1', '1.3.132.0.33', '1.3.132.0.10', '1.3.36.3.3.2.8.1.1.7',
  '1.3.36.3.3.2.8.1.1.11', '1.3.36.3.3.2.8.1.1.13', '1.3.132.0.1', '1.3.132.0.15', '1.3.132.0.26', '1.3.132.0.27', '1.3.132.0.16',
  '1.3.132.0.17', '1.3.132.0.36', '1.3.132.0.37', '1.3.132.0.38', '1.3.132.0.39']);
// pyca/cryptography's AlgorithmParameters: these OIDs take no parameters, or optional NULL
const ALG_NO_PARAMS = new Set(['1.2.840.10045.4.3.1', '1.2.840.10045.4.3.2', '1.2.840.10045.4.3.3', '1.2.840.10045.4.3.4',
  '2.16.840.1.101.3.4.3.9', '2.16.840.1.101.3.4.3.10', '2.16.840.1.101.3.4.3.11', '2.16.840.1.101.3.4.3.12',
  '1.3.101.110', '1.3.101.111', '1.3.101.112', '1.3.101.113', '2.16.840.1.101.3.4.3.1', '2.16.840.1.101.3.4.3.2',
  '2.16.840.1.101.3.4.3.3', '2.16.840.1.101.3.4.3.4']);
const ALG_NULL_PARAMS = new Set(['1.2.840.113549.1.1.1', '1.2.840.113549.1.1.5', '1.3.14.3.2.29', '1.2.840.113549.1.1.14',
  '1.2.840.113549.1.1.11', '1.2.840.113549.1.1.12', '1.2.840.113549.1.1.13', '1.3.14.3.2.26', '2.16.840.1.101.3.4.2.4',
  '2.16.840.1.101.3.4.2.1', '2.16.840.1.101.3.4.2.2', '2.16.840.1.101.3.4.2.3']);
const CURVE_SIZE = { [OID.p256]: 32, [OID.p384]: 48, [OID.p521]: 66, '1.2.840.10045.3.1.1': 24, '1.3.132.0.33': 28, '1.3.132.0.10': 32,
  '1.3.36.3.3.2.8.1.1.7': 32, '1.3.36.3.3.2.8.1.1.11': 48, '1.3.36.3.3.2.8.1.1.13': 64, '1.3.132.0.1': 21, '1.3.132.0.15': 21,
  '1.3.132.0.26': 30, '1.3.132.0.27': 30, '1.3.132.0.16': 36, '1.3.132.0.17': 36, '1.3.132.0.36': 52, '1.3.132.0.37': 52,
  '1.3.132.0.38': 72, '1.3.132.0.39': 72 };
// NIST prime curves (a = -3): the point must lie on the curve, as OpenSSL checks when pyca loads a key
const CURVE_PB = {
  [OID.p256]: ['ffffffff00000001000000000000000000000000ffffffffffffffffffffffff', '5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b'],
  [OID.p384]: ['fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000ffffffff',
    'b3312fa7e23ee7e4988e056be3f82d19181d9c6efe8141120314088f5013875ac656398d8a2ed19d2a85c8edd3ec2aef'],
  [OID.p521]: ['1' + 'f'.repeat(130), '51953eb9618e1c9a1f929a21a0b68540eea2da725b99b315f3b8b489918ef109e156193951ec7e937b1652c0bd3bb1bf073573df883d2c34f1ef451fd46b503f00'],
};
const big = b => BigInt('0x' + (toHex(b) || '0'));
const modpow = (a, e, m) => { let r = 1n; a %= m; while (e > 0n) { if (e & 1n) r = r * a % m; a = a * a % m; e >>= 1n; } return r; };
const toBytes = (n, size) => { const h = n.toString(16).padStart(2 * size, '0'); return Uint8Array.from(h.match(/../g), x => parseInt(x, 16)); };
// returns the uncompressed 04||x||y encoding, or null if the point is not on the curve
function curvePoint(curve, pt, size) {
  const [ph, bh] = CURVE_PB[curve], p = BigInt('0x' + ph), b = BigInt('0x' + bh);
  const x = big(pt.subarray(1, 1 + size));
  if (x >= p) return null;
  const r = ((((x * x % p) * x - 3n * x + b) % p) + p) % p;
  let y;
  if (pt[0] === 2 || pt[0] === 3) {
    y = modpow(r, (p + 1n) / 4n, p);
    if ((y * y) % p !== r) return null;
    if (Number(y & 1n) !== (pt[0] & 1)) y = (p - y) % p;
  } else {
    y = big(pt.subarray(1 + size));
    if (y >= p || (y * y) % p !== r) return null;
    if (pt[0] !== 4 && Number(y & 1n) !== (pt[0] & 1)) return null;
  }
  return concat(Uint8Array.of(4), toBytes(x, size), toBytes(y, size));
}
const SIG_HASH = {
  '1.2.840.10045.4.1': 'sha1', '1.2.840.10045.4.3.1': 'sha224', '1.2.840.10045.4.3.2': 'sha256',
  '1.2.840.10045.4.3.3': 'sha384', '1.2.840.10045.4.3.4': 'sha512',
  '1.2.840.113549.1.1.5': 'sha1', '1.2.840.113549.1.1.11': 'sha256', '1.2.840.113549.1.1.12': 'sha384',
  '1.2.840.113549.1.1.13': 'sha512', '1.2.840.113549.1.1.14': 'sha224', '1.3.101.112': null, '1.3.101.113': null,
};
const WEBCRYPTO_HASH = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };
// AlgorithmIdentifier: OID plus at most one parameter element; ECDSA signature OIDs allow no parameters or NULL
function parseAlg(e) {
  if (e.tag !== 0x30) bad('DER: bad AlgorithmIdentifier');
  const a = derAll(e.c);
  if (!a.length || a.length > 2 || a[0].tag !== 0x06) bad('DER: bad AlgorithmIdentifier');
  const oid = oidStr(a[0].c), params = a[1] || null;
  const isNull = params && params.tag === 0x05 && !params.c.length;
  if (params && params.tag === 0x05 && params.c.length) bad('DER: bad NULL');
  if (ALG_NO_PARAMS.has(oid) && params) bad('DER: unexpected AlgorithmIdentifier parameters');
  if (ALG_NULL_PARAMS.has(oid) && params && !isNull) bad('DER: AlgorithmIdentifier parameters must be NULL');
  if (oid === OID.ecPublicKey && !(params && (params.tag === 0x06 || isNull || params.tag === 0x30))) bad('DER: bad EC parameters');
  return { oid, params };
}
const DAYS = (y, m) => [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
function parseTime(e) {
  const s = String.fromCharCode(...e.c);
  let m, y;
  if (e.tag === 0x17 && (m = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s))) { y = +m[1]; y = y >= 50 ? 1900 + y : 2000 + y; }
  else if (e.tag === 0x18 && (m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s))) y = +m[1];
  else bad('X.509: bad time');
  const [mo, d, h, mi, se] = m.slice(2).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > DAYS(y, mo) || h > 23 || mi > 59 || se > 59) bad('X.509: bad time');
  return Date.UTC(y, mo - 1, d, h, mi, se);
}
const setOrdered = els => { for (let k = 1; k < els.length; k++) { const a = els[k - 1].raw, b = els[k].raw; let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; if ((i < a.length ? a[i] : -1) > (i < b.length ? b[i] : -1)) bad('DER: SET value was ordered incorrectly'); } return els; };
const PRINTABLE = /^[A-Za-z0-9 '()+,\-./:=?]*$/;
function strValueOk(tag, c) {
  if (tag === 0x13) return PRINTABLE.test(String.fromCharCode(...c));
  if (tag === 0x1c) {
    if (c.length % 4) return false;
    for (let i = 0; i < c.length; i += 4) { const v = ((c[i] << 24) >>> 0) + (c[i + 1] << 16) + (c[i + 2] << 8) + c[i + 3]; if (v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) return false; }
    return true;
  }
  if (tag === 0x1e) {
    if (c.length % 2) return false;
    for (let i = 0; i < c.length; i += 2) {
      const u = (c[i] << 8) | c[i + 1];
      if (u >= 0xdc00 && u <= 0xdfff) return false;
      if (u >= 0xd800 && u <= 0xdbff) { const n = i + 3 < c.length ? (c[i + 2] << 8) | c[i + 3] : -1; if (n < 0xdc00 || n > 0xdfff) return false; i += 2; }
    }
    return true;
  }
  return true;
}
// Name as rust-asn1 parses it at load: SEQUENCE OF SET OF {OID, value}, DER set order, typed strings valid
const parseName = e => derAll(e.c).map(set => {
  if (set.tag !== 0x31) bad('X.509: bad name');
  return setOrdered(derAll(set.c)).map(atv => atvParse(atv));
});
// cert.issuer / cert.subject as Python objects: only string types, BitString only for x500UniqueIdentifier,
// other strings valid UTF-8, no empty RDN. Returns a comparable key (RDN order kept, attributes as a set).
const ASN1_TYPES = new Set([3, 4, 12, 18, 19, 20, 22, 23, 24, 26, 28, 30]);
function nameAccess(n) {
  return JSON.stringify(n.map(rdn => {
    if (!rdn.length) bad('ValueError: a relative distinguished name cannot be empty');
    return [...new Set(rdn.map(a => {
      if (!ASN1_TYPES.has(a.tag)) bad('ValueError: name attribute value has an unexpected tag');
      if (a.tag === 3) { if (a.oid !== '2.5.4.45') bad('TypeError: oid must be X500_UNIQUE_IDENTIFIER for BitString type.'); }
      else if (a.tag !== 0x13 && a.tag !== 0x1c && a.tag !== 0x1e) { try { new TextDecoder('utf-8', { fatal: true }).decode(a.value); } catch (e) { bad('ValueError: name attribute is not UTF-8'); } }
      return `${a.oid}|${a.tag}|${toHex(a.value)}`;
    }))].sort();
  }));
}
const bitsOk = c => { if (!c.length || c[0] > 7 || (c.length === 1 && c[0]) || (c.length > 1 && (c[c.length - 1] & ((1 << c[0]) - 1)))) bad('DER: bad BIT STRING'); };
const ia5 = c => { if (c.some(x => x > 0x7f)) bad('DER: bad IA5String'); };
function atvParse(atv) {
  if (atv.tag !== 0x30) bad('X.509: bad name attribute');
  const a = derAll(atv.c);
  if (a.length !== 2 || a[0].tag !== 0x06) bad('X.509: bad name attribute');
  if (!strValueOk(a[1].tag, a[1].c)) bad('X.509: invalid string value in name');
  return { oid: oidStr(a[0].c), tag: a[1].tag, value: a[1].c };
}
// GeneralName as pyca/cryptography parses and converts it
function generalName(g) {
  switch (g.tag) {
    case 0xa0: { const [t, v] = derFields(g.c, [[0x06], [0xa0]]); oidStr(t.c); derOne(v.c, derAll(v.c)[0] ? derAll(v.c)[0].tag : -1); return; }
    case 0x81: case 0x82: case 0x86: ia5(g.c); return;
    case 0xa4: nameAccess(parseName({ c: derOne(g.c, 0x30).c })); return;
    case 0x87: if (g.c.length !== 4 && g.c.length !== 16) bad('ValueError: invalid IP address'); return;
    case 0x88: oidStr(g.c); return;
    case 0xa3: case 0xa5: return bad('UnsupportedGeneralNameType');
    default: return bad('DER: bad GeneralName');
  }
}
const generalNames = c => derAll(c).forEach(generalName);
// cert.extensions: duplicates rejected, and the extension types the GPU certs carry parsed strictly
function extAccess(c) {
  const seen = new Set();
  for (const [oid, v] of c.extList) {
    if (seen.has(oid)) bad(`DuplicateExtension: ${oid}`);
    seen.add(oid);
    if (oid === OID.basicConstraints) {
      const [caE, plen] = derFields(derOne(v, 0x30).c, [[0x01, true], [0x02, true]]);
      if (plen && (derIntOk(plen).c[0] & 0x80)) bad('DER: negative path length');
      if (caE && !derBool(caE)) bad('DER: DEFAULT value was explicitly encoded');
    } else if (oid === OID.keyUsage) {
      const k = derOne(v, 0x03).c;
      if (!k.length || k[0] > 7 || (k.length === 1 && k[0]) || (k.length > 1 && (k[k.length - 1] & ((1 << k[0]) - 1)))) bad('DER: bad KeyUsage');
    } else if (oid === '2.5.29.14') derOne(v, 0x04);
    else if (oid === '2.5.29.35') {
      const [, iss, ser] = derFields(derOne(v, 0x30).c, [[0x80, true], [0xa1, true], [0x82, true]]);
      if (iss) generalNames(iss.c);
      if (ser) derIntOk(ser);
    } else if (oid === '2.5.29.17' || oid === '2.5.29.18') generalNames(derOne(v, 0x30).c);
    else if (oid === '2.5.29.31' || oid === '2.5.29.46') {
      for (const dp of derAll(derOne(v, 0x30).c)) {
        if (dp.tag !== 0x30) bad('DER: bad DistributionPoint');
        const [dpn, reasons, crlIssuer] = derFields(dp.c, [[0xa0, true], [0x81, true], [0xa2, true]]);
        if (dpn) {
          const [inner] = derAll(dpn.c);
          if (!inner || derAll(dpn.c).length !== 1) bad('DER: bad DistributionPointName');
          if (inner.tag === 0xa0) generalNames(inner.c);
          else if (inner.tag === 0xa1) nameAccess([setOrdered(derAll(inner.c)).map(atvParse)]);
          else bad('DER: bad DistributionPointName');
        }
        if (reasons) bitsOk(reasons.c);
        if (crlIssuer) generalNames(crlIssuer.c);
      }
    } else if (oid === '1.3.6.1.5.5.7.1.1' || oid === '1.3.6.1.5.5.7.1.11') {
      for (const ad of derAll(derOne(v, 0x30).c)) {
        if (ad.tag !== 0x30) bad('DER: bad AccessDescription');
        const a = derAll(ad.c);
        if (a.length !== 2 || a[0].tag !== 0x06) bad('DER: bad AccessDescription');
        oidStr(a[0].c);
        generalName(a[1]);
      }
    }
  }
  return new Map(c.extList);
}

// Certificate, parsed as strictly as rust-asn1 parses it for pyca/cryptography (field order, DER integers,
// BOOLEANs, OIDs, SET ordering, no DEFAULT values encoded, no trailing data)
export function parseCert(der) {
  const top = derOne(der, 0x30);
  const [tbs, alg, sig] = derFields(top.c, [[0x30], [0x30], [0x03]]);
  const pad = at(sig.c, 0);
  if (pad > 7 || (sig.c.length === 1 && pad) || (sig.c.length > 1 && (sig.c[sig.c.length - 1] & ((1 << pad) - 1)))) bad('X.509: bad signature bits');
  const sigAlg = parseAlg(alg);
  const [ver, serial, innerAlg, issuer, validity, subject, spki, uid1, uid2, extsE] = derFields(tbs.c,
    [[0xa0, true], [0x02], [0x30], [0x30], [0x30], [0x30], [0x30], [0x81, true], [0x82, true], [0xa3, true]]);
  if (ver) { const v = derIntOk(derOne(ver.c, 0x02)); if (v.c.length !== 1 || v.c[0] !== 2) bad('InvalidVersion'); }
  derIntOk(serial);
  parseAlg(innerAlg);
  const [nb, na, ...more] = derAll(validity.c);
  if (!na || more.length) bad('X.509: bad validity');
  const [spkiAlgE, keyBits] = derFields(spki.c, [[0x30], [0x03]]);
  const spkiAlg = parseAlg(spkiAlgE);
  const kp = keyBits.c[0];
  if (!keyBits.c.length || kp > 7 || (keyBits.c.length === 1 && kp) || (keyBits.c.length > 1 && (keyBits.c[keyBits.c.length - 1] & ((1 << kp) - 1)))) bad('X.509: bad key bits');
  const extList = [];
  if (extsE) {
    for (const x of derAll(derOne(extsE.c, 0x30).c)) {
      if (x.tag !== 0x30) bad('X.509: bad extension');
      const p = derAll(x.c);
      let k = 0;
      if (!p[k] || p[k].tag !== 0x06) bad('X.509: bad extension');
      const oid = oidStr(p[k++].c);
      if (p[k] && p[k].tag === 0x01) { if (!derBool(p[k++])) bad('DER: DEFAULT value was explicitly encoded'); }
      if (!p[k] || p[k].tag !== 0x04 || k + 1 !== p.length) bad('X.509: bad extension');
      extList.push([oid, p[k].c]);
    }
  }
  return {
    der, tbs: tbs.raw, sigAlg: sigAlg.oid, signature: sig.c.subarray(1),
    issuer: parseName(issuer), subject: parseName(subject), notBefore: parseTime(nb), notAfter: parseTime(na),
    spki: spki.raw, point: keyBits.c.subarray(1), pointPad: kp, keyOid: spkiAlg.oid, curveOid: spkiAlg.params && spkiAlg.params.tag === 0x06 ? oidStr(spkiAlg.params.c) : null,
    curveParams: spkiAlg.params, extList,
  };
}
const sigHash = c => { if (!(c.sigAlg in SIG_HASH)) bad(`UnsupportedAlgorithm: signature algorithm ${c.sigAlg}`); return SIG_HASH[c.sigAlg]; };

// strict DER ECDSA-Sig-Value -> raw r||s; anything malformed is a failed signature, as with OpenSSL
function derSigToRaw(sig, size) {
  try {
    const seq = derOne(sig, 0x30);
    const ints = derAll(seq.c);
    if (ints.length !== 2) throw 0;
    const parts = ints.map(e => {
      let v = e.c;
      if (e.tag !== 0x02 || !v.length || (v[0] & 0x80) || (v.length > 1 && v[0] === 0 && !(v[1] & 0x80))) throw 0;
      while (v.length > 1 && v[0] === 0) v = v.subarray(1);
      if (v.length > size) throw 0;
      return concat(new Uint8Array(size - v.length), v);
    });
    return concat(...parts);
  } catch (e) {
    throw new SignatureError();
  }
}
// cert.public_key(): unknown key types and curves fail to load, as do EC points not on the curve
async function loadKey(c) {
  if (!KNOWN_KEYS.has(c.keyOid)) bad(`UnsupportedAlgorithm: Unknown key type: ${c.keyOid}`);
  if (c.keyOid !== OID.ecPublicKey) return null;
  if (!c.curveOid) bad('ValueError: EC key without a named curve');
  if (!KNOWN_CURVES.has(c.curveOid)) bad(`UnsupportedAlgorithm: Curve ${c.curveOid} is not supported`);
  // OpenSSL's point rules: unused bits 0; uncompressed (04), hybrid (06/07, y parity in the prefix) or compressed (02/03)
  const size = CURVE_SIZE[c.curveOid], pt = c.point;
  if (c.pointPad || !((pt.length === 1 + 2 * size && [4, 6, 7].includes(pt[0])) || (pt.length === 1 + size && (pt[0] === 2 || pt[0] === 3)))) bad('ValueError: Invalid key');
  if (!CURVES[c.curveOid]) return null;
  const xy = curvePoint(c.curveOid, pt, size);
  if (!xy) bad('ValueError: Invalid key');
  try {
    return await subtle.importKey('raw', xy, { name: 'ECDSA', namedCurve: CURVES[c.curveOid][0] }, false, ['verify']);
  } catch (e) { return bad('ValueError: Invalid key'); }
}
async function importEcKey(c) {
  const k = await loadKey(c);
  if (!k) bad('public key is not a P-256, P-384 or P-521 EC key');
  return k;
}
async function ecdsaVerify(key, hash, rawSig, data) {
  if (!(await subtle.verify({ name: 'ECDSA', hash }, key, rawSig, data))) throw new SignatureError();
}
// parent.public_key().verify(child.signature, child.tbs_certificate_bytes, ECDSA(child.signature_hash_algorithm))
async function verifyCertSig(child, parent) {
  const h = sigHash(child);
  const key = await importEcKey(parent);
  if (!WEBCRYPTO_HASH[h]) bad(`hash ${h} not supported here`);
  await ecdsaVerify(key, WEBCRYPTO_HASH[h], derSigToRaw(child.signature, CURVES[parent.curveOid][1]), child.tbs);
}
// raw r||s (int.from_bytes of each half) over msg with the given hash
async function verifyRawSig(sig, half, msg, key, size, hash) {
  const pad = x => concat(new Uint8Array(Math.max(0, size - x.length)), x.subarray(Math.max(0, x.length - size)));
  const r = sig.subarray(0, half), s = sig.subarray(half, 2 * half);
  const big = x => x.some((v, k) => v && k < x.length - size);
  if (big(r) || big(s)) throw new SignatureError();
  await ecdsaVerify(key, hash, concat(pad(r), pad(s)), msg);
}

// ---------- PEM (pem crate 4.0, as used by cryptography's load_pem_x509_certificates) ----------
const asc = s => te.encode(s);
function readUntil(b, from, marker) {
  let index = from, found = 0;
  while (b.length - index >= marker.length - found) {
    if (b[index] === marker[found]) found++; else found = 0;
    index++;
    if (found === marker.length) return [index, from, index - found];
  }
  return null;
}
const skipWs = (b, i) => { while (i < b.length && (b[i] === 32 || b[i] === 9 || b[i] === 10 || b[i] === 13)) i++; return i; };
const RUST_WS = new Set([0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
const strictUtf8 = b => { try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b); } catch (e) { return bad('PEM: not UTF-8'); } };
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function b64decodeStrict(s) {
  if (s.length % 4) bad('base64: invalid length');
  let padN = 0;
  while (padN < s.length && s[s.length - 1 - padN] === '=') padN++;
  if (padN > 2) bad('base64: invalid padding');
  const body = s.slice(0, s.length - padN);
  const out = [];
  let acc = 0, bits = 0;
  for (const ch of body) {
    const v = B64.indexOf(ch);
    if (v < 0) bad('base64: invalid byte');
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
    acc &= (1 << bits) - 1;
  }
  if (acc) bad('base64: invalid last symbol');
  return Uint8Array.from(out);
}
export function pemParseMany(b) {
  const blocks = [];
  let pos = 0;
  while (pos < b.length) {
    const r1 = readUntil(b, pos, asc('-----BEGIN ')); if (!r1) break;
    const r2 = readUntil(b, r1[0], asc('-----')); if (!r2) break;
    const p0 = skipWs(b, r2[0]);
    const r3 = readUntil(b, p0, asc('-----END ')); if (!r3) break;
    const payload = b.subarray(p0, r3[2]);
    let headers = new Uint8Array(0), data = payload;
    const h1 = readUntil(payload, 0, asc('\n\n')) || readUntil(payload, 0, asc('\r\n\r\n'));
    if (h1) { headers = payload.subarray(0, h1[2]); data = payload.subarray(h1[0]); }
    const r4 = readUntil(b, r3[0], asc('-----')); if (!r4) break;
    pos = skipWs(b, r4[0]);
    const tag = strictUtf8(b.subarray(r2[1], r2[2]));
    if (!tag) bad('PEM: missing begin tag');
    const tagEnd = strictUtf8(b.subarray(r4[1], r4[2]));
    if (!tagEnd) bad('PEM: missing end tag');
    if (tag !== tagEnd) bad(`PEM: mismatched tags ${tag} / ${tagEnd}`);
    const raw = Array.from(strictUtf8(data)).filter(c => !RUST_WS.has(c.codePointAt(0))).join('');
    const contents = b64decodeStrict(raw);
    const hs = strictUtf8(headers);
    const lines = hs === '' ? [] : hs.split('\n');
    if (hs.endsWith('\n')) lines.pop();
    for (const l of lines) if (!l.replace(/\r$/, '').includes(':')) bad('PEM: invalid header');
    blocks.push({ tag, contents });
  }
  return blocks;
}
export function loadPemCerts(b) {
  const certs = pemParseMany(b).filter(p => p.tag === 'CERTIFICATE' || p.tag === 'X509 CERTIFICATE').map(p => parseCert(p.contents));
  if (!certs.length) bad('PEM: no certificates found');
  return certs;
}

// ---------- tdxq.py ----------
const HDR = 48, BODY = 584;

// Steps: an optional recorder so a page can show which check is running when one fails.
const noSteps = { begin() {}, done() {} };

export async function verifyQuote(q, steps = noSteps) {
  steps.begin('Quote header: TDX v4, ECDSA P-256 attestation key');
  const ver = u16(q, 0), akt = u16(q, 2), tee = u32(q, 4);
  ok(ver === 4 && tee === 0x81, `not a TDX v4 quote (version=${ver} tee=0x${tee.toString(16)})`);
  ok(akt === 2, `att_key_type ${akt}: only ECDSA P-256 handled`);
  const body = q.subarray(HDR, HDR + BODY);
  const sigLen = u32(q, HDR + BODY);
  const sd = q.subarray(HDR + BODY + 4, HDR + BODY + 4 + sigLen);
  const sig = sd.subarray(0, 64), attkey = sd.subarray(64, 128);
  const ct = u16(sd, 128), cl = u32(sd, 130);
  ok(ct === 6, `cert_data_type ${ct}`);
  const cd = sd.subarray(134, 134 + cl);
  const qeReport = cd.subarray(0, 384), qeSig = cd.subarray(384, 448);
  const al = u16(cd, 448);
  const auth = cd.subarray(450, 450 + al);
  const ct2 = u16(cd, 450 + al), cl2 = u32(cd, 452 + al);
  ok(ct2 === 5, `inner cert_data_type ${ct2}`);
  steps.begin('PCK certificate chain: each certificate signed by the next');
  const certs = loadPemCerts(cd.subarray(456 + al, 456 + al + cl2));
  for (let k = 0; k + 1 < certs.length; k++) await verifyCertSig(certs[k], certs[k + 1]);
  const root = certs[certs.length - 1];
  steps.begin('Chain root is self-signed');
  await verifyCertSig(root, root);
  steps.begin(`Chain root is the Intel SGX Root CA (sha256 ${INTEL_ROOT_SHA256.slice(0, 16)}...)`);
  const rootFp = toHex(await sha256(root.der));
  ok(rootFp === INTEL_ROOT_SHA256, 'quote chain root is not Intel SGX Root CA');
  steps.begin('Quoting Enclave report signed by the PCK leaf certificate');
  const leafKey = await importEcKey(certs[0]);
  await verifyRawSig(qeSig, 32, qeReport, leafKey, CURVES[certs[0].curveOid][1], 'SHA-256');
  steps.begin('Attestation key bound to the Quoting Enclave report');
  ok(eqBytes(qeReport.subarray(320, 352), await sha256(concat(attkey, auth))), 'attestation key not bound to QE report');
  steps.begin('Quote signed by the attestation key');
  const pad32 = x => concat(new Uint8Array(Math.max(0, 32 - x.length)), x);
  let pub;
  try {
    pub = await subtle.importKey('raw', concat(Uint8Array.of(4), pad32(attkey.subarray(0, 32)), pad32(attkey.subarray(32))),
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch (e) { bad('attestation key is not a valid P-256 point'); }
  await verifyRawSig(sig, 32, q.subarray(0, HDR + BODY), pub, 32, 'SHA-256');
  steps.done();
  const rtmr = [];
  for (let o = 328; o < 520; o += 48) rtmr.push(toHex(body.subarray(o, o + 48)));
  return {
    mr_td: toHex(body.subarray(136, 184)), rtmr, report_data: toHex(body.subarray(520, 584)),
    tee_tcb_svn: toHex(body.subarray(0, 16)), intel_root_sha256: rootFp, intel_root_pinned: 'fingerprint',
  };
}

export async function replayRtmr3(eventLog) {
  const events = typeof eventLog === 'string' ? pyJsonLoads(eventLog) : eventLog;
  let rtmr = new Uint8Array(48);
  let formulaOk = true;
  const seen = [];
  for (const e of pyIter(events)) {
    if (!pyEqNum(get(e, 'imr'), 3)) continue;
    const d = fromHex(item(e, 'digest'));
    const payload = fromHex(get(e, 'event_payload', ''));
    const et = get(e, 'event_type', new PyInt(0n));
    const etv = et === true ? 1n : et === false ? 0n : et instanceof PyInt ? et.v : bad('struct.error: required argument is not an integer');
    if (etv < 0n || etv > 0xffffffffn) bad("struct.error: 'I' format requires 0 <= number <= 4294967295");
    const ev = get(e, 'event', '');
    if (typeof ev !== 'string') bad(`AttributeError: '${pyType(ev)}' object has no attribute 'encode'`);
    const n = Number(etv);
    const calc = await sha384(concat(Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff), asc(':'), utf8(ev), asc(':'), payload));
    if (!eqBytes(calc, d)) formulaOk = false;
    rtmr = await sha384(concat(rtmr, d));
    seen.push({ event: ev, payload: toHex(payload) });
  }
  return [toHex(rtmr), seen, formulaOk];
}
export const composeHash = events => { for (const e of events) if (e.event === 'compose-hash') return e.payload; return null; };

// ---------- gpuq.py ----------
const SIG_LEN = 96, REQ_LEN = 37, OPAQUE_DRIVER = 3, OPAQUE_VBIOS = 6, OPAQUE_FWID = 20;

export function parseReport(report) {
  ok(report.length > REQ_LEN + 8 + 32 + 2 + SIG_LEN, 'report too short');
  const req = report.subarray(0, REQ_LEN);
  ok(req[0] === 0x11 && req[1] === 0xe0, 'not an SPDM 1.1 GET_MEASUREMENTS request');
  ok(req[2] === 0x01, 'request did not ask for a signature');
  const r = report.subarray(REQ_LEN);
  ok(r[0] === 0x11 && r[1] === 0x60, 'not an SPDM 1.1 MEASUREMENTS response');
  const nblocks = r[4];
  const reclen = r[5] | (r[6] << 8) | (r[7] << 16);
  const rec = r.subarray(8, 8 + reclen);
  ok(rec.length === reclen, 'measurement record truncated');
  let off = 8 + reclen;
  const respNonce = r.subarray(off, off + 32); off += 32;
  const olen = u16(r, off); off += 2;
  const opaque = r.subarray(off, off + olen); off += olen;
  const sig = r.subarray(off, off + SIG_LEN); off += SIG_LEN;
  ok(sig.length === SIG_LEN && off === r.length, `bad response length (${r.length - off} trailing bytes)`);
  const blocks = [];
  for (let i = 0; i < rec.length;) {
    const idx = at(rec, i), spec = at(rec, i + 1), size = u16(rec, i + 2);
    const body = rec.subarray(i + 4, i + 4 + size);
    ok(body.length === size && size >= 3, 'measurement block truncated');
    const vsize = u16(body, 1);
    ok(3 + vsize === size, 'measurement value size mismatch');
    blocks.push({ index: idx, spec, type: body[0], value: body.subarray(3, 3 + vsize) });
    i += 4 + size;
  }
  ok(blocks.length === nblocks, `${blocks.length} measurement blocks parsed, header says ${nblocks}`);
  const tlv = new Map();
  let j = 0;
  while (j + 4 <= opaque.length) {
    const t = u16(opaque, j), s = u16(opaque, j + 2);
    tlv.set(t, opaque.subarray(j + 4, j + 4 + s));
    j += 4 + s;
  }
  ok(j === opaque.length, 'opaque data is not a clean TLV list');
  return { requesterNonce: req.subarray(4, 36), responderNonce: respNonce, blocks, opaque: tlv, signature: sig, signed: report.subarray(0, report.length - SIG_LEN) };
}
const driverVersion = tlv => {
  const v = tlv.get(OPAQUE_DRIVER);
  if (!v || !v.length) return null;
  let e = v.length; while (e > 0 && v[e - 1] === 0) e--;
  return Array.from(v.subarray(0, e), c => (c < 128 ? String.fromCharCode(c) : '\ufffd')).join('');
};
const vbiosVersion = tlv => {
  const v = tlv.get(OPAQUE_VBIOS);
  if (!v || v.length < 5) return null;
  const h = x => x.toString(16).toUpperCase().padStart(2, '0');
  return `${h(v[3])}.${h(v[2])}.${h(v[1])}.${h(v[0])}.${h(v[4])}`;
};

export async function verifyChain(chainPem, rootPem = null, now = Date.now()) {
  const pinned = loadPemCerts(utf8(rootPem === null ? NVIDIA_ROOT_PEM : rootPem))[0];
  if (typeof chainPem !== 'string' && !(chainPem instanceof Uint8Array)) bad(`AttributeError: '${pyType(chainPem)}' object has no attribute 'encode'`);
  const certs = loadPemCerts(typeof chainPem === 'string' ? utf8(chainPem) : chainPem);
  ok(certs.length === 5, `expected 5 certs in the GPU chain, got ${certs.length}`);
  for (let k = 0; k < certs.length; k++) {
    const c = certs[k];
    await loadKey(c);
    ok(c.keyOid === OID.ecPublicKey && c.curveOid === OID.p384, `cert ${k}: not a P-384 key`);
    ok(sigHash(c) === 'sha384', `cert ${k}: not SHA-384`);
    ok(c.notBefore <= now && now <= c.notAfter, `cert ${k}: outside its validity window`);
    if (k > 0) {
      const bc = extAccess(c).get(OID.basicConstraints);
      if (!bc) bad('ExtensionNotFound: basicConstraints');
      const [caE] = derFields(derOne(bc, 0x30).c, [[0x01, true], [0x02, true]]);
      const ca = caE ? derBool(caE) : false;
      if (caE && !ca) bad('DER: DEFAULT value was explicitly encoded');
      ok(ca, `cert ${k}: not a CA but signs cert ${k - 1}`);
    }
  }
  const ku = extAccess(certs[0]).get(OID.keyUsage);
  if (!ku) bad('ExtensionNotFound: keyUsage');
  const kub = derOne(ku, 0x03).c;
  if (!kub.length || kub[0] > 7 || (kub.length === 1 && kub[0]) || (kub.length > 1 && (kub[kub.length - 1] & ((1 << kub[0]) - 1)))) bad('DER: bad KeyUsage');
  ok(kub.length > 1 && (kub[1] & 0x80), 'leaf cert may not sign');
  for (let k = 0; k + 1 < certs.length; k++) {
    const iss = nameAccess(certs[k].issuer);
    ok(iss === nameAccess(certs[k + 1].subject), `cert ${k}: issuer is not the next cert`);
    await verifyCertSig(certs[k], certs[k + 1]);
  }
  const root = certs[certs.length - 1];
  await verifyCertSig(root, root);
  ok(eqBytes(root.der, pinned.der), 'GPU chain root is not the pinned NVIDIA Device Identity CA');
  return certs;
}
const subjectSerial = c => {
  nameAccess(c.subject);
  for (const rdn of c.subject) for (const a of rdn) if (a.oid === OID.serialNumber) return new TextDecoder().decode(a.value);
  return null;
};

export async function verifyReport(report, chainPem, expectedNonce = null, rootPem = null, steps = noSteps) {
  steps.begin('GPU report: SPDM 1.1 GET_MEASUREMENTS framing');
  const p = parseReport(report);
  if (expectedNonce !== null) {
    steps.begin('GPU report requester nonce equals the statement digest');
    const en = typeof expectedNonce === 'string' ? fromHex(expectedNonce) : expectedNonce;
    ok(en.length === 32, 'expected nonce must be 32 bytes');
    ok(eqBytes(p.requesterNonce, en), 'GPU report requester nonce is not the expected digest');
  }
  steps.begin('GPU certificate chain: 5 P-384 certs up to the pinned NVIDIA Device Identity CA');
  const certs = await verifyChain(chainPem, rootPem);
  steps.begin('GPU report signed by the leaf device key');
  const leafKey = await importEcKey(certs[0]);
  await verifyRawSig(p.signature, 48, p.signed, leafKey, 48, 'SHA-384');
  const fwid = p.opaque.has(OPAQUE_FWID) ? p.opaque.get(OPAQUE_FWID) : null;
  if (fwid !== null) {
    steps.begin('GPU report FWID matches the leaf certificate');
    const ext = extAccess(certs[0]).get(OID.tcbInfo);
    if (!ext) bad('ExtensionNotFound: TcbInfo');
    const tail = fwid.length === 0 ? ext : ext.subarray(Math.max(0, ext.length - fwid.length));
    ok(eqBytes(tail, fwid), 'report FWID does not match the leaf certificate FWID');
  }
  steps.done();
  return {
    requester_nonce: toHex(p.requesterNonce),
    report_sha256: toHex(await sha256(report)),
    device_id: subjectSerial(certs[1]),
    root_sha256: toHex(await sha256(certs[certs.length - 1].der)),
    measurement_blocks: p.blocks.length,
    measurements_sha256: toHex(await sha256(concat(...p.blocks.map(b => b.value)))),
    driver_version: driverVersion(p.opaque),
    vbios_version: vbiosVersion(p.opaque),
    fwid_checked: fwid !== null,
  };
}

export async function checkGpuSection(gpu, canonicalStatement, rootPem = null, steps = noSteps) {
  const report = fromHex(item(gpu, 'report'));
  const d = await sha256(canonicalStatement);
  const m = await verifyReport(report, item(gpu, 'cert_chain'), d, rootPem, steps);
  if (gpu.has('report_sha256')) ok(item(gpu, 'report_sha256') === m.report_sha256, 'gpu.report_sha256 does not match the report');
  return m;
}
export const scoreReportDataV2 = async (canonicalStatement, gpuReport) =>
  toHex(await sha256(concat(asc('tessera:score:v2'), canonicalStatement, await sha256(gpuReport))));

// ---------- verify_bundle.py ----------
// opts: requireGpu, nvRootPem (tests only), quoteHook (tests only: mirrors tests/_mocks.py quote_shim),
// steps ({begin(label), done()}), log (line callback; lines are also returned).
export async function verifyBundle(b, opts = {}) {
  if (typeof b === 'string') b = pyJsonLoads(b);
  const { requireGpu = false, nvRootPem = null, quoteHook = null, steps = noSteps } = opts;
  const lines = [];
  const log = l => { lines.push(l); if (opts.log) opts.log(l); };
  const st = item(b, 'statement');
  const gpu = get(b, 'gpu');
  const v2 = gpu !== null || get(st, 'v') === 'tessera-score-2' || get(item(b, 'score'), 'binding') === 'tessera:score:v2';
  let g = null, rd2;
  const rd1 = toHex(await sha256(concat(asc('tessera:keyrelease:v1'), fromHex(item(st, 'enclave_pubkey')), fromHex(item(st, 'challenge')))));
  if (v2) {
    steps.begin('Bundle is a GPU-bound (v2) score with a GPU section');
    ok(gpu !== null, 'v2 statement but the bundle has no gpu section');
    ok(get(st, 'v') === 'tessera-score-2', 'gpu section on a statement that is not tessera-score-2');
    g = await checkGpuSection(gpu, canonical(st), nvRootPem, steps);
    rd2 = await scoreReportDataV2(canonical(st), fromHex(item(gpu, 'report')));
    log(`GPU report OK: NVIDIA Device Identity CA, nonce = statement digest, device ${pyStr(g.device_id)}, `
      + `driver ${pyStr(g.driver_version)}, VBIOS ${pyStr(g.vbios_version)}`);
  } else {
    steps.begin('Bundle is a CPU-only (v1) score');
    ok(!requireGpu, 'CPU-only (v1) bundle, but a GPU-bound score was required');
    rd2 = toHex(await sha256(concat(asc('tessera:score:v1'), canonical(st))));
  }
  const ms = [];
  const parts = [['key-release', item(b, 'key_release'), rd1], ['score', item(b, 'score'), rd2]];
  for (const [label, part, rd] of parts) {
    const qb = fromHex(item(part, 'quote'));
    const prefixed = { begin: l => steps.begin(`${label} quote: ${l}`), done() {} };
    let m = await verifyQuote(qb, prefixed);
    if (quoteHook) m = quoteHook(qb, m);
    steps.begin(`${label} quote: report_data binds the ${label === 'score' ? 'score statement' : 'enclave key and challenge'}`);
    ok(m.report_data.slice(0, 64) === rd, `${label} quote does not bind its statement`);
    steps.begin(`${label} quote: event log replays to RTMR3`);
    const [r3, events] = await replayRtmr3(item(part, 'event_log'));
    ok(r3 === m.rtmr[3], `${label} event log does not replay to RTMR3`);
    m.compose_hash = composeHash(events);
    ms.push(m);
    log(`${label} quote OK: Intel root, report_data bound, RTMR3 replayed`);
  }
  steps.begin('Both quotes come from the same measured enclave (MRTD and RTMRs)');
  ok(ms[0].mr_td === ms[1].mr_td && ms[0].rtmr.join() === ms[1].rtmr.join(), 'quotes come from different enclaves');
  steps.begin('statement_sha256 is the hash of the canonical statement');
  ok(toHex(await sha256(canonical(st))) === item(b, 'statement_sha256'));
  steps.done();
  const version = v2 ? 'v2' : 'v1';
  log(`score ${pyStr(item(st, 'correct'))}/${pyStr(item(st, 'n'))} for ${pyStr(item(st, 'model_id'))}@${pyHead(item(st, 'model_revision'), 10)} `
    + `on suite ${pyStr(item(st, 'suite_id'))} (${pyHead(item(st, 'suite_commitment'), 16)}...)` + (v2 ? ' [GPU-bound, v2]' : ' [CPU-only, v1]'));
  log(`enclave app compose hash ${pyStr(ms[0].compose_hash)} (compare with sha256 of the published app-compose)`);
  const memo = `tessera:score:${version}:${pyStr(item(b, 'statement_sha256'))}:${pyStr(item(st, 'correct'))}/${pyStr(item(st, 'n'))}`;
  log(`expected Solana memo: ${memo}`);
  const solSig = get(b, 'solana_devnet_signature');
  const truthy = !(solSig === null || solSig === false || solSig === '' || (Array.isArray(solSig) && !solSig.length)
    || (solSig instanceof Map && !solSig.size) || ((solSig instanceof PyInt || solSig instanceof PyFloat) && Number(solSig.v) === 0));
  let explorer = null;
  if (truthy) { explorer = `https://explorer.solana.com/tx/${pyStr(solSig)}?cluster=devnet`; log(explorer); }
  return { version, quotes: ms, gpu: g, memo, explorer, lines, statement: st };
}

// Plain-JS view of a parsed statement, for display.
export function toPlain(o) {
  if (o instanceof Map) return Object.fromEntries([...o].map(([k, v]) => [k, toPlain(v)]));
  if (Array.isArray(o)) return o.map(toPlain);
  if (o instanceof PyInt) return Number(o.v);
  if (o instanceof PyFloat) return o.v;
  return o;
}
