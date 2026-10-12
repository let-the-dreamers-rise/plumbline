"""Test helpers: fixtures, a mock dstack_sdk, a mock pynvml / nv_attestation_sdk, and a test GPU PKI.

What is real and what is mocked in these tests:
  - NVIDIA: hardest-build/fixtures/hopper* is NVIDIA's real sample report + chain (verified for real).
    For the end-to-end enclave tests we need a GPU report whose nonce is OUR statement digest, which only
    a real GPU can sign under NVIDIA's root; so those use a test 5-cert P-384 chain built here, and the
    verifier's pinned root is swapped for the test root (gpuq.NVIDIA_ROOT_PEM) inside those tests only.
  - TDX: the mock dstack returns hardest-build/fixtures/tdx/quote.bin (a real H200-host TDX v4 quote,
    verified for real to Intel's root). Its report_data is fixed, so the mock appends a marker + the
    requested report_data after the quote's signed bytes, and quote_shim() substitutes that value after
    the real verification has passed. Everything else (chain, QE report, signatures) is checked on real bytes.
"""
import os, sys, json, types, struct, hashlib, datetime, contextlib
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIX = '/mnt/project-files/hardest-build/fixtures'
sys.path[:0] = [ROOT, os.path.join(ROOT, 'enclave')]
os.environ['no_proxy'] = os.environ['NO_PROXY'] = '127.0.0.1,localhost'

SAMPLE_REPORT = bytes.fromhex(open(f'{FIX}/hopperAttestationReport.txt').read().strip())
SAMPLE_CHAIN = open(f'{FIX}/hopperCertChain.txt', 'rb').read()
SAMPLE_ROOT = open(f'{FIX}/verifier_device_root.pem', 'rb').read()
SAMPLE_NONCE = '931d8dd0add203ac3d8b4fbde75e115278eefcdceac5b87671a748f32364dfcb'
H200_REPORT = open(f'{FIX}/tdx/gpu_report.bin', 'rb').read()
H200_NONCE = open(f'{FIX}/tdx/nonce.txt').read().strip()
TDX_QUOTE = open(f'{FIX}/tdx/quote.bin', 'rb').read()
TDX_REPORT_DATA = open(f'{FIX}/tdx/report_data.bin', 'rb').read()
MARK = b'TESSERA-MOCK-RD:'


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print('  ok:', msg)


def rejects(fn, msg):
    try:
        fn()
    except Exception as e:
        print(f'  ok: rejected: {msg} ({type(e).__name__}: {str(e)[:90]})')
        return
    raise AssertionError('NOT rejected: ' + msg)


# ---------- test GPU PKI (shape of NVIDIA's: 5 certs, P-384/SHA-384, FWID in leaf TcbInfo) ----------
def _name(cn, serial=None):
    attrs = [x509.NameAttribute(NameOID.COMMON_NAME, cn), x509.NameAttribute(NameOID.ORGANIZATION_NAME, 'Tessera Test')]
    if serial:
        attrs.append(x509.NameAttribute(NameOID.SERIAL_NUMBER, serial))
    return x509.Name(attrs)


def make_test_pki(fwid=None):
    fwid = fwid or hashlib.sha384(b'test fwid').digest()
    names = [_name('TEST GSP FMC LF', 'AA00'), _name('TEST GSP BROM', 'DEADBEEF0001'), _name('TEST Provisioner ICA'),
             _name('TEST Identity'), _name('TEST Device Identity CA')]
    keys = [ec.generate_private_key(ec.SECP384R1()) for _ in names]
    nb = datetime.datetime(2021, 1, 1, tzinfo=datetime.timezone.utc)
    na = datetime.datetime(9999, 12, 31, 23, 59, 59, tzinfo=datetime.timezone.utc)
    certs = [None] * 5
    for k in range(4, -1, -1):
        issuer = names[k + 1] if k < 4 else names[4]
        ikey = keys[k + 1] if k < 4 else keys[4]
        b = (x509.CertificateBuilder().subject_name(names[k]).issuer_name(issuer).public_key(keys[k].public_key())
             .serial_number(x509.random_serial_number()).not_valid_before(nb).not_valid_after(na))
        if k == 0:
            b = b.add_extension(x509.KeyUsage(True, False, False, False, False, False, False, False, False), True)
            # minimal DICE TcbInfo-like value ending in the 48-byte FWID (gpuq compares the tail, as nvtrust does)
            b = b.add_extension(x509.UnrecognizedExtension(x509.ObjectIdentifier('2.23.133.5.4.1'), b'\x30\x34\x04\x30' + fwid), False)
        else:
            b = b.add_extension(x509.BasicConstraints(ca=True, path_length=None), True)
        certs[k] = b.sign(ikey, hashes.SHA384())
    chain = b''.join(c.public_bytes(serialization.Encoding.PEM) for c in certs)
    return {'chain': chain, 'root': certs[4].public_bytes(serialization.Encoding.PEM), 'leaf_key': keys[0], 'fwid': fwid}


def build_report(nonce, leaf_key, fwid, nblocks=4):
    """SPDM 1.1 GET_MEASUREMENTS request + signed MEASUREMENTS response, NVIDIA layout."""
    req = bytes([0x11, 0xE0, 0x01, 0xFF]) + nonce + b'\x00'
    rec = b''
    for i in range(1, nblocks + 1):
        val = hashlib.sha384(b'block%d' % i).digest()
        body = bytes([0x01]) + struct.pack('<H', len(val)) + val
        rec += bytes([i, 0x01]) + struct.pack('<H', len(body)) + body
    tlv = lambda t, v: struct.pack('<HH', t, len(v)) + v
    opaque = tlv(3, b'595.71.05\0') + tlv(6, bytes.fromhex('00cf009602000000')) + tlv(20, fwid)
    resp = (bytes([0x11, 0x60, 0x00, 0x00, nblocks]) + len(rec).to_bytes(3, 'little') + rec + os.urandom(32)
            + struct.pack('<H', len(opaque)) + opaque)
    signed = req + resp
    r, s = decode_dss_signature(leaf_key.sign(signed, ec.ECDSA(hashes.SHA384())))
    return signed + r.to_bytes(48, 'big') + s.to_bytes(48, 'big')


# ---------- mock dstack_sdk ----------
DSTACK_CALLS = []


def install_fake_dstack():
    used = struct.unpack_from('<I', TDX_QUOTE, 48 + 584)[0] + 48 + 584 + 4
    m = types.ModuleType('dstack_sdk')

    class DstackClient:
        def get_quote(self, report_data):
            DSTACK_CALLS.append(bytes(report_data))
            rd = bytes(report_data).ljust(64, b'\0')
            return types.SimpleNamespace(quote=(TDX_QUOTE[:used] + MARK + rd).hex(), event_log='[]')
    m.DstackClient = DstackClient
    sys.modules['dstack_sdk'] = m
    return m


@contextlib.contextmanager
def quote_shim():
    """Real tdxq.verify_quote on the fixture bytes, then report_data := the value the mock dstack was asked for."""
    import tdxq
    real = tdxq.verify_quote

    def shim(q, intel_root_der=None):
        m = real(q, intel_root_der)
        i = q.rfind(MARK)
        if i >= 0:
            m['report_data'] = q[i + len(MARK):i + len(MARK) + 64].hex()
        return m
    tdxq.verify_quote = shim
    try:
        yield
    finally:
        tdxq.verify_quote = real


# ---------- mock pynvml / nv_attestation_sdk ----------
NVML_CALLS = []


def install_fake_pynvml(pki, wrong_nonce=False):
    m = types.ModuleType('pynvml')
    m.nvmlInit = lambda: NVML_CALLS.append('init')
    m.nvmlShutdown = lambda: NVML_CALLS.append('shutdown')
    m.nvmlDeviceGetHandleByIndex = lambda i: ('handle', i)

    def report(h, nonce):
        NVML_CALLS.append(('report', h, bytes(nonce)))
        n = bytes(32) if wrong_nonce else bytes(nonce)
        rep = build_report(n, pki['leaf_key'], pki['fwid'])
        return types.SimpleNamespace(attestationReportSize=len(rep), attestationReport=list(rep) + [0] * 64)

    def cert(h):
        c = pki['chain']
        return types.SimpleNamespace(attestationCertChainSize=len(c), attestationCertChain=list(c) + [0] * 16,
                                     certChainSize=0, certChain=[])
    m.nvmlDeviceGetConfComputeGpuAttestationReport = report
    m.nvmlDeviceGetConfComputeGpuCertificate = cert
    sys.modules['pynvml'] = m
    return m


def install_fake_sdk(pki):
    import base64
    pkg = types.ModuleType('nv_attestation_sdk')
    att = types.ModuleType('nv_attestation_sdk.attestation')
    att.Devices = types.SimpleNamespace(GPU='GPU')
    att.Environment = types.SimpleNamespace(LOCAL='LOCAL', REMOTE='REMOTE')

    class Attestation:
        def set_name(self, n): pass
        def add_verifier(self, *a): self.v = a
        def set_nonce(self, h): self.nonce = bytes.fromhex(h)

        def get_evidence(self):
            rep = build_report(self.nonce, pki['leaf_key'], pki['fwid'])
            return [{'arch': 'HOPPER', 'evidence': base64.b64encode(rep).decode(),
                     'certificate': base64.b64encode(pki['chain']).decode()}]
    att.Attestation = Attestation
    pkg.attestation = att
    sys.modules['nv_attestation_sdk'] = pkg
    sys.modules['nv_attestation_sdk.attestation'] = att


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
