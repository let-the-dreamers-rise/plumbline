"""Builds fixtures/synthetic-quote.bin: a TDX v4 quote laid out exactly like a real one, whose
report_data binds fixtures/statement-v1.json, signed by a throwaway PCK chain rooted in
fixtures/test-root.der. Header and TD body (mr_td, RTMR0-2, TCB) are copied from the real Intel quote;
RTMR3 is the replay of fixtures/synthetic-event-log.json, a dstack-style event log whose compose-hash
event carries sha256(b"synthetic app-compose for tests") (fixtures/synthetic-compose-hash.txt).

Plumbline additions, all signed by the same throwaway chain:
- fixtures/statement-v1-payout.json: statement-v1 plus `payout` (hex of the test payout pubkey in
  fixtures/payout-pubkey.txt), and fixtures/synthetic-quote-payout.bin bound to it.
- fixtures/synthetic-event-log-stripped.json: the same log with every digest emptied, as dstack-cloud's
  GetQuote returns it; it replays to the same RTMR3 once the guest computes the digests.

Only the `test-root` build of the guest pins this root, so this lets the whole pipeline
(guest -> proof -> Solana) be tested end to end without a real enclave run. The production image
pins Intel's root and rejects this quote.

    python3 fixtures/make_synthetic_quote.py"""
import os, sys, json, struct, hashlib, datetime, base64
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

here = os.path.dirname(os.path.abspath(__file__))
HDR, BODY = 48, 584


def raw_sign(key, msg):
    r, s = decode_dss_signature(key.sign(msg, ec.ECDSA(hashes.SHA256())))
    return r.to_bytes(32, 'big') + s.to_bytes(32, 'big')


def name(cn):
    return x509.Name([x509.NameAttribute(NameOID.ORGANIZATION_NAME, 'Tessera TEST ONLY'), x509.NameAttribute(NameOID.COMMON_NAME, cn)])


def cert(subject, subject_key, issuer, issuer_key, ca):
    now = datetime.datetime(2026, 1, 1)
    b = (x509.CertificateBuilder().subject_name(name(subject)).issuer_name(name(issuer))
         .public_key(subject_key.public_key()).serial_number(x509.random_serial_number())
         .not_valid_before(now).not_valid_after(now + datetime.timedelta(days=3650))
         .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True))
    return b.sign(issuer_key, hashes.SHA256())


DSTACK_EVENT = 0x08000001


def event(name, payload):
    digest = hashlib.sha384(struct.pack('<I', DSTACK_EVENT) + b':' + name.encode() + b':' + payload).digest()
    return {'imr': 3, 'event_type': DSTACK_EVENT, 'digest': digest.hex(), 'event': name, 'event_payload': payload.hex()}


def main():
    compose = hashlib.sha256(b'synthetic app-compose for tests').digest()
    log = [event('system-preparing', b''), event('app-id', bytes(20)), event('compose-hash', compose),
           event('instance-id', bytes(20)), event('boot-mr-done', b'')]
    rtmr3 = bytes(48)
    for e in log:
        rtmr3 = hashlib.sha384(rtmr3 + bytes.fromhex(e['digest'])).digest()

    real = open(os.path.join(here, 'intel-real-quote.bin'), 'rb').read()
    statement = open(os.path.join(here, 'statement-v1.json'), 'rb').read()
    payout_hex = b58decode(open(os.path.join(here, 'payout-pubkey.txt')).read().split()[0]).hex()
    st = json.loads(statement)
    st['payout'] = payout_hex
    statement_payout = json.dumps(st, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()

    root_k, ca_k, pck_k, att_k = (ec.generate_private_key(ec.SECP256R1()) for _ in range(4))
    root = cert('Test Root CA', root_k, 'Test Root CA', root_k, True)
    ca = cert('Test PCK Platform CA', ca_k, 'Test Root CA', root_k, True)
    pck = cert('Test PCK Certificate', pck_k, 'Test PCK Platform CA', ca_k, False)
    pem = b''.join(c.public_bytes(serialization.Encoding.PEM) for c in (pck, ca, root))
    chain = (pck_k, att_k, pem)
    q1 = make_quote(real, statement, rtmr3, chain)
    q2 = make_quote(real, statement_payout, rtmr3, chain)

    open(os.path.join(here, 'synthetic-quote.bin'), 'wb').write(q1)
    open(os.path.join(here, 'synthetic-quote-payout.bin'), 'wb').write(q2)
    open(os.path.join(here, 'statement-v1-payout.json'), 'wb').write(statement_payout)
    open(os.path.join(here, 'test-root.der'), 'wb').write(root.public_bytes(serialization.Encoding.DER))
    json.dump(log, open(os.path.join(here, 'synthetic-event-log.json'), 'w'), indent=1)
    stripped = [dict(e, digest='') for e in log]
    json.dump(stripped, open(os.path.join(here, 'synthetic-event-log-stripped.json'), 'w'), indent=1)
    open(os.path.join(here, 'synthetic-compose-hash.txt'), 'w').write(compose.hex() + '\n')
    print('synthetic-quote.bin', len(q1), 'bytes; synthetic-quote-payout.bin', len(q2), 'bytes; payout', payout_hex)


B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'


def b58decode(s):
    n = 0
    for c in s:
        n = n * 58 + B58.index(c)
    raw = n.to_bytes((n.bit_length() + 7) // 8, 'big')
    out = bytes(len(s) - len(s.lstrip('1'))) + raw
    assert len(out) == 32, 'payout must be a 32-byte pubkey'
    return out


def make_quote(real, statement, rtmr3, chain):
    pck_k, att_k, pem = chain
    rd = hashlib.sha256(b'tessera:score:v1' + statement).digest() + bytes(32)

    signed = bytearray(real[:HDR + BODY])
    signed[HDR + 520:HDR + 584] = rd
    signed[HDR + 472:HDR + 520] = rtmr3
    nums = att_k.public_key().public_numbers()
    att_pub = nums.x.to_bytes(32, 'big') + nums.y.to_bytes(32, 'big')
    auth = os.urandom(32)
    qe_report = bytearray(os.urandom(384))
    qe_report[320:352] = hashlib.sha256(att_pub + auth).digest()
    qe_report[352:384] = bytes(32)
    cd = (bytes(qe_report) + raw_sign(pck_k, bytes(qe_report)) + struct.pack('<H', len(auth)) + auth
          + struct.pack('<HI', 5, len(pem)) + pem)
    sd = raw_sign(att_k, bytes(signed)) + att_pub + struct.pack('<HI', 6, len(cd)) + cd
    return bytes(signed) + struct.pack('<I', len(sd)) + sd


if __name__ == '__main__':
    main()
