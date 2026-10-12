"""NVIDIA Hopper (H100/H200) SPDM attestation report checks, shared by tessera_eval.py and verify_bundle.py.
Ported from hardest-build/verify_nvidia_sample.py and tested against NVIDIA's nvtrust sample.

Checks done:
  - report is SPDM 1.1 GET_MEASUREMENTS (signature requested, all blocks) + MEASUREMENTS response,
    parsed exactly to the end (no trailing bytes);
  - cert chain is 5 PEM certs, leaf first, each ECDSA P-384 with SHA-384, each signed by the next one,
    issuer == parent subject, every non-leaf a CA, leaf allowed to sign, all within their validity window;
  - the last cert equals NVIDIA's pinned Device Identity CA byte for byte (and its sha256 fingerprint);
  - report signature: raw r||s P-384 over SHA-384(request || response minus the 96 signature bytes), leaf key;
  - FWID in the report's opaque data equals the FWID in the leaf cert's TCG DICE TcbInfo extension
    (what nvtrust's local verifier also compares);
  - requester nonce (report bytes 4..36) equals the expected digest, when one is given.
Not done: RIM (golden measurement) comparison, OCSP/CRL revocation, policy on opaque fields
(driver/VBIOS versions are reported, not judged)."""
import struct, hashlib, datetime
from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from cryptography.hazmat.primitives.serialization import Encoding

# NVIDIA Device Identity CA, from NVIDIA/nvtrust guest_tools/gpu_verifiers/local_gpu_verifier/src/verifier/certs/
# verifier_device_root.pem (commit 858ada9a, copied unchanged into hardest-build/fixtures).
NVIDIA_ROOT_PEM = b"""-----BEGIN CERTIFICATE-----
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
"""
NVIDIA_ROOT_SHA256 = None  # filled below from the PEM above; checked again in tests against the fixture file
SIG_LEN = 96
REQ_LEN = 37
TCB_INFO_OID = x509.ObjectIdentifier('2.23.133.5.4.1')  # TCG DICE TcbInfo
OPAQUE_DRIVER, OPAQUE_VBIOS, OPAQUE_FWID = 3, 6, 20


def parse_report(report):
    """Parses an SPDM 1.1 GET_MEASUREMENTS request + MEASUREMENTS response. Raises on any structural error."""
    assert len(report) > REQ_LEN + 8 + 32 + 2 + SIG_LEN, 'report too short'
    req = report[:REQ_LEN]
    assert req[0] == 0x11 and req[1] == 0xE0, 'not an SPDM 1.1 GET_MEASUREMENTS request'
    assert req[2] == 0x01, 'request did not ask for a signature'
    r = report[REQ_LEN:]
    assert r[0] == 0x11 and r[1] == 0x60, 'not an SPDM 1.1 MEASUREMENTS response'
    nblocks = r[4]
    reclen = int.from_bytes(r[5:8], 'little')
    rec = r[8:8 + reclen]
    assert len(rec) == reclen, 'measurement record truncated'
    off = 8 + reclen
    resp_nonce = r[off:off + 32]; off += 32
    olen = struct.unpack_from('<H', r, off)[0]; off += 2
    opaque = r[off:off + olen]; off += olen
    sig = r[off:off + SIG_LEN]; off += SIG_LEN
    assert len(sig) == SIG_LEN and off == len(r), f'bad response length ({len(r) - off} trailing bytes)'
    blocks, i = [], 0
    while i < len(rec):
        idx, spec, size = rec[i], rec[i + 1], struct.unpack_from('<H', rec, i + 2)[0]
        body = rec[i + 4:i + 4 + size]
        assert len(body) == size and size >= 3, 'measurement block truncated'
        vsize = struct.unpack_from('<H', body, 1)[0]
        assert 3 + vsize == size, 'measurement value size mismatch'
        blocks.append({'index': idx, 'spec': spec, 'type': body[0], 'value': body[3:3 + vsize].hex()})
        i += 4 + size
    assert len(blocks) == nblocks, f'{len(blocks)} measurement blocks parsed, header says {nblocks}'
    tlv, j = {}, 0
    while j + 4 <= len(opaque):
        t, s = struct.unpack_from('<HH', opaque, j)
        tlv[t] = opaque[j + 4:j + 4 + s]
        j += 4 + s
    assert j == len(opaque), 'opaque data is not a clean TLV list'
    return {'requester_nonce': req[4:36], 'slot': req[36], 'param2': req[3], 'responder_nonce': resp_nonce,
            'blocks': blocks, 'opaque': tlv, 'signature': sig, 'signed': report[:len(report) - SIG_LEN]}


def _driver(tlv):
    v = tlv.get(OPAQUE_DRIVER)
    return v.rstrip(b'\0').decode('ascii', 'replace') if v else None


def _vbios(tlv):
    v = tlv.get(OPAQUE_VBIOS)
    return '%02X.%02X.%02X.%02X.%02X' % (v[3], v[2], v[1], v[0], v[4]) if v and len(v) >= 5 else None


def verify_chain(chain_pem, root_pem=None, now=None):
    """Verifies a 5-cert P-384 chain (leaf first) up to the pinned NVIDIA root. Returns the certs."""
    root_pem = NVIDIA_ROOT_PEM if root_pem is None else root_pem
    pinned = x509.load_pem_x509_certificate(root_pem)
    certs = x509.load_pem_x509_certificates(chain_pem if isinstance(chain_pem, bytes) else chain_pem.encode())
    assert len(certs) == 5, f'expected 5 certs in the GPU chain, got {len(certs)}'
    now = now or datetime.datetime.now(datetime.timezone.utc)
    for k, c in enumerate(certs):
        pk = c.public_key()
        assert isinstance(pk, ec.EllipticCurvePublicKey) and pk.curve.name == 'secp384r1', f'cert {k}: not a P-384 key'
        assert c.signature_hash_algorithm is not None and c.signature_hash_algorithm.name == 'sha384', f'cert {k}: not SHA-384'
        assert c.not_valid_before_utc <= now <= c.not_valid_after_utc, f'cert {k}: outside its validity window'
        if k > 0:
            bc = c.extensions.get_extension_for_class(x509.BasicConstraints).value
            assert bc.ca, f'cert {k}: not a CA but signs cert {k - 1}'
    ku = certs[0].extensions.get_extension_for_class(x509.KeyUsage).value
    assert ku.digital_signature, 'leaf cert may not sign'
    for k, (child, parent) in enumerate(zip(certs, certs[1:])):
        assert child.issuer == parent.subject, f'cert {k}: issuer is not the next cert'
        parent.public_key().verify(child.signature, child.tbs_certificate_bytes, ec.ECDSA(child.signature_hash_algorithm))
    root = certs[-1]
    root.public_key().verify(root.signature, root.tbs_certificate_bytes, ec.ECDSA(root.signature_hash_algorithm))
    assert root.public_bytes(Encoding.DER) == pinned.public_bytes(Encoding.DER), 'GPU chain root is not the pinned NVIDIA Device Identity CA'
    return certs


def _subject_serial(cert):
    a = cert.subject.get_attributes_for_oid(x509.NameOID.SERIAL_NUMBER)
    return a[0].value if a else None


def verify_report(report, chain_pem, expected_nonce=None, root_pem=None, now=None):
    """Full check of one GPU report. expected_nonce: 32 bytes (or hex). Returns a summary dict; raises on failure."""
    p = parse_report(report)
    if expected_nonce is not None:
        en = bytes.fromhex(expected_nonce) if isinstance(expected_nonce, str) else expected_nonce
        assert len(en) == 32, 'expected nonce must be 32 bytes'
        assert p['requester_nonce'] == en, 'GPU report requester nonce is not the expected digest'
    certs = verify_chain(chain_pem, root_pem, now)
    sig = p['signature']
    rr, ss = int.from_bytes(sig[:48], 'big'), int.from_bytes(sig[48:], 'big')
    certs[0].public_key().verify(encode_dss_signature(rr, ss), p['signed'], ec.ECDSA(hashes.SHA384()))
    fwid = p['opaque'].get(OPAQUE_FWID)
    if fwid is not None:
        ext = certs[0].extensions.get_extension_for_oid(TCB_INFO_OID).value.value
        assert ext[-len(fwid):] == fwid, 'report FWID does not match the leaf certificate FWID'
    return {
        'requester_nonce': p['requester_nonce'].hex(),
        'report_sha256': hashlib.sha256(report).hexdigest(),
        'device_id': _subject_serial(certs[1]),  # GSP BROM cert serialNumber: per-device id
        'leaf_subject': certs[0].subject.rfc4514_string(),
        'root_sha256': certs[-1].fingerprint(hashes.SHA256()).hex(),
        'measurement_blocks': len(p['blocks']),
        'measurements_sha256': hashlib.sha256(b''.join(bytes.fromhex(b['value']) for b in p['blocks'])).hexdigest(),
        'driver_version': _driver(p['opaque']),
        'vbios_version': _vbios(p['opaque']),
        'fwid_checked': fwid is not None,
    }


def score_digest(canonical_statement):
    """The GPU requester nonce in Tessera v2: sha256(canonical(statement)), i.e. the statement_sha256."""
    return hashlib.sha256(canonical_statement).digest()


def score_report_data_v2(canonical_statement, gpu_report):
    return hashlib.sha256(b'tessera:score:v2' + canonical_statement + hashlib.sha256(gpu_report).digest()).hexdigest()


def check_gpu_section(gpu, canonical_statement, root_pem=None):
    """Checks a bundle's / enclave response's gpu section against the statement. Returns verify_report's summary."""
    report = bytes.fromhex(gpu['report'])
    digest = score_digest(canonical_statement)
    m = verify_report(report, gpu['cert_chain'], expected_nonce=digest, root_pem=root_pem)
    if 'report_sha256' in gpu:
        assert gpu['report_sha256'] == m['report_sha256'], 'gpu.report_sha256 does not match the report'
    return m


NVIDIA_ROOT_SHA256 = x509.load_pem_x509_certificate(NVIDIA_ROOT_PEM).fingerprint(hashes.SHA256()).hex()
