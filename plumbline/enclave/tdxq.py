"""Intel TDX v4 quote checks and dstack event-log replay, shared by tessera_eval.py and verify_bundle.py.
Ported from hardest-build/verify_tdx_quote.py. Checks: PCK chain to a self-signed root (pinned to
Intel's root when given), QE report signed by the PCK leaf, attestation key bound to the QE report,
quote signed by the attestation key. Not checked: TCB info, QE identity, CRLs (need Intel collateral)."""
import struct, hashlib, json
from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from cryptography.hazmat.primitives.serialization import Encoding

HDR, BODY = 48, 584
INTEL_ROOT_SHA256 = '44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3'  # Intel SGX Root CA
INTEL_ROOT_URL = 'https://certificates.trustedservices.intel.com/Intel_SGX_Provisioning_Certification_RootCA.pem'


def _p256(sig, msg, pub):
    r, s = int.from_bytes(sig[:32], 'big'), int.from_bytes(sig[32:64], 'big')
    pub.verify(encode_dss_signature(r, s), msg, ec.ECDSA(hashes.SHA256()))


def verify_quote(q, intel_root_der=None):
    """Returns the measured fields; raises on any failed check."""
    ver, akt, tee = struct.unpack_from('<HHI', q, 0)
    assert ver == 4 and tee == 0x81, f'not a TDX v4 quote (version={ver} tee={tee:#x})'
    assert akt == 2, f'att_key_type {akt}: only ECDSA P-256 handled'
    body = q[HDR:HDR + BODY]
    sig_len = struct.unpack_from('<I', q, HDR + BODY)[0]
    sd = q[HDR + BODY + 4:HDR + BODY + 4 + sig_len]
    sig, attkey = sd[:64], sd[64:128]
    ct, cl = struct.unpack_from('<HI', sd, 128)
    assert ct == 6, f'cert_data_type {ct}'
    cd = sd[134:134 + cl]
    qe_report, qe_sig = cd[:384], cd[384:448]
    al = struct.unpack_from('<H', cd, 448)[0]
    auth = cd[450:450 + al]
    ct2, cl2 = struct.unpack_from('<HI', cd, 450 + al)
    assert ct2 == 5, f'inner cert_data_type {ct2}'
    certs = x509.load_pem_x509_certificates(cd[456 + al:456 + al + cl2])
    for child, parent in zip(certs, certs[1:]):
        parent.public_key().verify(child.signature, child.tbs_certificate_bytes, ec.ECDSA(child.signature_hash_algorithm))
    root = certs[-1]
    root.public_key().verify(root.signature, root.tbs_certificate_bytes, ec.ECDSA(root.signature_hash_algorithm))
    assert root.fingerprint(hashes.SHA256()).hex() == INTEL_ROOT_SHA256, 'quote chain root is not Intel SGX Root CA'
    root_pinned = 'fingerprint'
    if intel_root_der is not None:
        assert root.public_bytes(Encoding.DER) == intel_root_der, 'quote chain root differs from the Intel root fetched from Intel'
        root_pinned = 'fingerprint+fetched'
    _p256(qe_sig, qe_report, certs[0].public_key())
    assert qe_report[320:352] == hashlib.sha256(attkey + auth).digest(), 'attestation key not bound to QE report'
    pub = ec.EllipticCurvePublicNumbers(int.from_bytes(attkey[:32], 'big'), int.from_bytes(attkey[32:], 'big'),
                                        ec.SECP256R1()).public_key()
    _p256(sig, q[:HDR + BODY], pub)
    return {
        'mr_td': body[136:184].hex(),
        'rtmr': [body[o:o + 48].hex() for o in range(328, 520, 48)],
        'report_data': body[520:584].hex(),
        'tee_tcb_svn': body[0:16].hex(),
        'intel_root_sha256': root.fingerprint(hashes.SHA256()).hex(),
        'intel_root_pinned': root_pinned,
    }


def load_intel_root(path_or_bytes):
    raw = path_or_bytes if isinstance(path_or_bytes, bytes) else open(path_or_bytes, 'rb').read()
    if raw.lstrip().startswith(b'-----BEGIN'):
        return x509.load_pem_x509_certificate(raw).public_bytes(Encoding.DER)
    return x509.load_der_x509_certificate(raw).public_bytes(Encoding.DER)


def replay_rtmr3(event_log):
    """Replays dstack's RTMR3 from the event log. Returns (rtmr3_hex, events, digest_formula_ok).
    digest_formula_ok says whether each event's digest recomputes as
    sha384(event_type_le32 || ':' || event || ':' || payload), our reading of dstack's format."""
    events = json.loads(event_log) if isinstance(event_log, str) else event_log
    rtmr = bytes(48)
    formula_ok = True
    seen = []
    for e in events:
        if e.get('imr') != 3:
            continue
        d = bytes.fromhex(e['digest'])
        payload = bytes.fromhex(e.get('event_payload', ''))
        calc = hashlib.sha384(struct.pack('<I', e.get('event_type', 0)) + b':' + e.get('event', '').encode() + b':' + payload).digest()
        if calc != d:
            formula_ok = False
        rtmr = hashlib.sha384(rtmr + d).digest()
        seen.append({'event': e.get('event', ''), 'payload': payload.hex()})
    return rtmr.hex(), seen, formula_ok


def compose_hash(events):
    for e in events:
        if e['event'] == 'compose-hash':
            return e['payload']
    return None
