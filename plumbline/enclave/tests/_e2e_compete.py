"""Competition end to end with no network: the real competition enclave HTTP handler (server.H) on localhost,
with server._open replaced by a fake HTTPS host that serves throwaway files from memory (so host checks,
redirect checks, size limits and the per-shard sha256 check all run for real), a stub model, the mock dstack
from _mocks, and the real sponsor/entrant flow (compete_client). Everything is written to a fresh temp dir;
no real suite is involved."""
import os, io, sys, json, hashlib, tempfile, threading
from _mocks import *

WORK = tempfile.mkdtemp(prefix='plumbline-compete-test-')
os.environ['WORK_DIR'] = os.path.join(WORK, 'weights')
WEB = {}          # url -> (status, headers, body bytes)
GATES = {}        # url -> threading.Event that the fake download waits on before serving
REACHED = {}      # url -> threading.Event set when a download of that url has started (the enclave is busy)
OPEN_CALLS = []
CFG = {'model_type': 'llama', 'architectures': ['LlamaForCausalLM']}


class Body(io.BytesIO):
    def __init__(self, data, gate=None, reached=None):
        super().__init__(data)
        self.gate, self.reached = gate, reached

    def read(self, n=-1):
        if self.reached is not None:
            self.reached.set()
        if self.gate is not None and not self.gate.wait(300):
            raise TimeoutError('test gate never opened')
        return super().read(n)


def fake_open(url):
    OPEN_CALLS.append(url)
    status, headers, data = WEB.get(url, (404, {}, b'not found'))
    return status, dict(headers), Body(data, GATES.get(url), REACHED.get(url))


def hf(model_id, rev, name):
    return f'https://huggingface.co/{model_id}/resolve/{rev}/{name}'


def put(url, data, headers=None):
    WEB[url] = (200, dict({'Content-Length': str(len(data))}, **(headers or {})), data)


def redirect(url, to):
    WEB[url] = (302, {'Location': to}, b'')


def publish_model(model_id, rev, shards, cfg=CFG, index=True, tok_cfg=None):
    """Serves config/tokenizer at model_id@rev and each (file, bytes) shard. Returns the request weights list."""
    put(hf(model_id, rev, 'config.json'), json.dumps(cfg).encode())
    put(hf(model_id, rev, 'tokenizer_config.json'), json.dumps(tok_cfg or {'chat_template': 'x'}).encode())
    if len(shards) > 1 and index:
        put(hf(model_id, rev, 'model.safetensors.index.json'),
            json.dumps({'weight_map': {f'w{i}': f for i, (f, _) in enumerate(shards)}}).encode())
    out = []
    for f, b in shards:
        put(hf(model_id, rev, f), b)
        out.append({'file': f, 'sha256': hashlib.sha256(b).hexdigest()})
    return out


R = lambda n, seed: hashlib.sha256(seed).digest() * (n // 32)


def start_enclave(server, answers_by_model):
    server._open = fake_open
    os.makedirs(server.WORK_DIR, exist_ok=True)
    server.STATE.update(ready=True)
    server.load_weights = lambda path, spec: ('stub-tokenizer', spec['model_id'])  # no torch here
    server.answer = lambda q: answers_by_model.get(server.M['model'], {}).get(q)
    srv = server.ThreadingHTTPServer(('127.0.0.1', 0), server.H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f'http://127.0.0.1:{srv.server_address[1]}'


def offline_client():
    import tessera_eval, tdxq
    tdxq.INTEL_ROOT_URL = 'http://127.0.0.1:9/'
    tessera_eval.solana_challenge = lambda: (os.urandom(32).hex(), {'source': 'test'})
