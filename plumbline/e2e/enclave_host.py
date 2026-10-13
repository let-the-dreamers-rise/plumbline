"""TEST ONLY. Runs the real competition enclave (plumbline/enclave/enclave/server.py, imported unmodified)
on localhost with three stand-ins, like enclave/tests/_e2e_compete.py does:

  * dstack: a stub `dstack_sdk` whose get_quote() returns a TDX v4 quote built the same way
    zk/fixtures/make_synthetic_quote.py builds one (header + TD body copied from the real Intel quote,
    report_data and RTMR3 set, signed by a throwaway PCK chain), but chained to the e2e test root minted by
    mint_test_root.py (whose PCK key we kept). The event log is a dstack-style RTMR3 log with a
    compose-hash event; its replay equals the quote's RTMR3.
  * HTTPS: server._open is replaced by a fake huggingface.co (with an LFS-style redirect to a *.hf.co
    host) serving a tiny config/tokenizer and a one-shard model.safetensors from memory. The enclave's own
    host, redirect, size and sha256 checks run for real.
  * model: load_weights() and answer() are replaced by a fake model: a regex arithmetic solver for the
    gen_suite.py templates. No torch, no transformers.

    python3 enclave_host.py --port 18080 --pki <dir from mint_test_root.py> --work <dir> --model-json <out>
Writes <out> = {model_id, revision, file, sha256, size, compose_hash} for the entrant and the registry config.
"""
import argparse, hashlib, io, json, os, re, struct, sys, types

ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, required=True)
ap.add_argument('--pki', required=True)
ap.add_argument('--work', required=True)
ap.add_argument('--model-json', required=True)
args = ap.parse_args()

HERE = os.path.dirname(os.path.abspath(__file__))
PLUMBLINE = os.path.dirname(HERE)
os.environ['WORK_DIR'] = os.path.join(args.work, 'weights')
sys.path.insert(0, os.path.join(PLUMBLINE, 'enclave', 'enclave'))

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

# ---------------- dstack stub: test-root-signed quotes + a replayable RTMR3 event log ----------------
HDR, BODY = 48, 584
REAL = open(os.path.join(PLUMBLINE, 'zk', 'fixtures', 'intel-real-quote.bin'), 'rb').read()
PCK_KEY = serialization.load_pem_private_key(open(os.path.join(args.pki, 'pck-key.pem'), 'rb').read(), None)
PCK_PEM = open(os.path.join(args.pki, 'pck-chain.pem'), 'rb').read()
DSTACK_EVENT = 0x08000001
# Stand-in for the dstack app-compose hash: sha256 of the measured compose file this enclave ships in.
COMPOSE_HASH = hashlib.sha256(open(os.path.join(PLUMBLINE, 'enclave', 'docker-compose.compete.yml'), 'rb').read()).digest()


def raw_sign(key, msg):
    r, s = decode_dss_signature(key.sign(msg, ec.ECDSA(hashes.SHA256())))
    return r.to_bytes(32, 'big') + s.to_bytes(32, 'big')


def event(name, payload):
    digest = hashlib.sha384(struct.pack('<I', DSTACK_EVENT) + b':' + name.encode() + b':' + payload).digest()
    return {'imr': 3, 'event_type': DSTACK_EVENT, 'digest': digest.hex(), 'event': name, 'event_payload': payload.hex()}


LOG = [event('system-preparing', b''), event('app-id', hashlib.sha256(b'plumbline e2e app').digest()[:20]),
       event('compose-hash', COMPOSE_HASH), event('instance-id', os.urandom(20)), event('boot-mr-done', b'')]
RTMR3 = bytes(48)
for e in LOG:
    RTMR3 = hashlib.sha384(RTMR3 + bytes.fromhex(e['digest'])).digest()
QUOTES = []


def make_quote(report_data):
    """make_synthetic_quote.make_quote with the report_data given by the enclave (padded to 64 bytes)."""
    rd = bytes(report_data).ljust(64, b'\0')
    signed = bytearray(REAL[:HDR + BODY])
    signed[HDR + 520:HDR + 584] = rd
    signed[HDR + 472:HDR + 520] = RTMR3
    att_k = ec.generate_private_key(ec.SECP256R1())
    nums = att_k.public_key().public_numbers()
    att_pub = nums.x.to_bytes(32, 'big') + nums.y.to_bytes(32, 'big')
    auth = os.urandom(32)
    qe_report = bytearray(os.urandom(384))
    qe_report[320:352] = hashlib.sha256(att_pub + auth).digest()
    qe_report[352:384] = bytes(32)
    cd = (bytes(qe_report) + raw_sign(PCK_KEY, bytes(qe_report)) + struct.pack('<H', len(auth)) + auth
          + struct.pack('<HI', 5, len(PCK_PEM)) + PCK_PEM)
    sd = raw_sign(att_k, bytes(signed)) + att_pub + struct.pack('<HI', 6, len(cd)) + cd
    return bytes(signed) + struct.pack('<I', len(sd)) + sd


class DstackClient:
    def get_quote(self, report_data):
        QUOTES.append(bytes(report_data).hex())
        return types.SimpleNamespace(quote=make_quote(report_data).hex(), event_log=json.dumps(LOG))


sys.modules['dstack_sdk'] = types.SimpleNamespace(DstackClient=DstackClient)

import server  # noqa: E402  the real, unmodified enclave code

# ---------------- fake huggingface.co ----------------
MODEL_ID = 'plumbline-e2e/regex-arith-solver'
REVISION = hashlib.sha1(b'plumbline e2e fake model').hexdigest()
WEIGHTS = (b'plumbline e2e fake model: a regex arithmetic solver, not a neural network\n' * 64)
WEB = {}


def hf(name):
    return f'https://huggingface.co/{MODEL_ID}/resolve/{REVISION}/{name}'


def put(url, data):
    WEB[url] = (200, {'Content-Length': str(len(data))}, data)


put(hf('config.json'), json.dumps({'model_type': 'llama', 'architectures': ['LlamaForCausalLM']}).encode())
put(hf('tokenizer_config.json'), json.dumps({'chat_template': '{{ messages }}'}).encode())
LFS = f'https://cdn-lfs.hf.co/repos/e2e/{hashlib.sha256(WEIGHTS).hexdigest()}'
WEB[hf('model.safetensors')] = (302, {'Location': LFS}, b'')
put(LFS, WEIGHTS)
FETCHED = []


class Body(io.BytesIO):
    pass


def fake_open(url):
    FETCHED.append(url)
    status, headers, data = WEB.get(url, (404, {}, b'not found'))
    return status, dict(headers), Body(data)


# ---------------- fake model ----------------
N = r'(-?\d+)'
SOLVERS = [
    (rf'buys {N} boxes of \w+ with {N} \w+ in each box, then gives away {N}', lambda b, a, g: a * b - g),
    (rf'at {N} rupees each\. \w+ buys {N} and pays with {N} rupees', lambda p, b, paid: paid - p * b),
    (rf'reads {N} pages on Monday, {N} times as many on Tuesday, and {N} fewer', lambda a, b, c: a + a * b + (a - c)),
    (rf'^{N} \w+ are packed equally into {N} trucks, .* among {N} shops', lambda tot, b, c: tot // (b * c)),
    (rf'saves {N} rupees a week for {N} weeks, spends {N} rupees, then saves {N} more weeks',
     lambda a, b, s, d: a * b - s + a * d),
]


def fake_answer(question):
    for pat, f in SOLVERS:
        m = re.search(pat, question)
        if m:
            return str(f(*map(int, m.groups())))
    return None


def fake_load_weights(path, spec):
    data = open(os.path.join(path, 'model.safetensors'), 'rb').read()
    assert hashlib.sha256(data).hexdigest() == spec['shards'][0]['sha256']
    return 'fake-tokenizer', 'fake-model'


server._open = fake_open
server.load_weights = fake_load_weights
server.answer = fake_answer
os.makedirs(server.WORK_DIR, exist_ok=True)
server.STATE.update(ready=True)  # boot() would import torch; the fake model needs none

json.dump({'model_id': MODEL_ID, 'revision': REVISION, 'file': 'model.safetensors',
           'sha256': hashlib.sha256(WEIGHTS).hexdigest(), 'size': len(WEIGHTS),
           'compose_hash': COMPOSE_HASH.hex(), 'rtmr3': RTMR3.hex()}, open(args.model_json, 'w'), indent=1)
print('e2e enclave (real server.py, stub dstack/HTTPS/model) on 127.0.0.1:%d, pubkey %s' % (args.port, server.PK.hex()), flush=True)
srv = server.ThreadingHTTPServer(('127.0.0.1', args.port), server.H)
srv.serve_forever()
