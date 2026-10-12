# Plumbline competition-mode enclave. Runs inside an Intel TDX CVM (Phala Cloud / dstack).
# Same protocol as the sealed-eval board enclave (tessera:keyrelease:v1, tessera:score:v1, statement
# v = tessera-score-1 with the same fields) plus one statement field, payout: the entrant's 32-byte Solana
# pubkey as 64 lowercase hex. Instead of a pinned board, any entrant names a model by
# (model_id, revision, weights [{file or url, sha256}]) and the enclave enforces hard limits that are part of
# this measured file and the measured compose: allowed hosts, total weight size, architecture allowlist,
# timeouts, one evaluation at a time. This file is embedded verbatim in docker-compose.compete.yml.
import os, re, gc, json, time, base64, shutil, hashlib, tempfile, threading, traceback
import urllib.request, urllib.error
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, urljoin, unquote, parse_qs
from nacl.public import PrivateKey, SealedBox

MAX_ITEMS = 200
SK = PrivateKey.generate()
PK = bytes(SK.public_key)
STATE = {'ready': False, 'error': None, 'busy': False, 'stage': None, 'last_error': None, 'entries': 0}
M = {}
EVAL_LOCK = threading.Lock()  # one entry at a time; a second concurrent /enter gets 409
DTYPES = ('float32', 'bfloat16')
HF_HOST = 'huggingface.co'
# model_type -> the only architecture class accepted for it. All are built into the pinned transformers
# release; nothing is ever loaded with trust_remote_code.
ARCHS = {
    'llama': 'LlamaForCausalLM',
    'mistral': 'MistralForCausalLM',
    'qwen2': 'Qwen2ForCausalLM',
    'gemma': 'GemmaForCausalLM',
    'gemma2': 'Gemma2ForCausalLM',
    'phi3': 'Phi3ForCausalLM',
    'granite': 'GraniteForCausalLM',
}
# Small files fetched from model_id@revision next to the weights. config.json is required.
AUX_FILES = ('config.json', 'generation_config.json', 'model.safetensors.index.json', 'tokenizer.json',
             'tokenizer_config.json', 'special_tokens_map.json', 'tokenizer.model', 'vocab.json', 'merges.txt',
             'added_tokens.json')
REQ_KEYS = {'challenge', 'sealed', 'model_id', 'revision', 'payout', 'dtype', 'weights', 'shards', 'weights_sha256'}


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def need(cond, msg):
    if not cond:  # not assert: these checks must survive python -O
        raise ValueError(msg)


class Reject(Exception):
    """A refusal before the suite is decrypted. Its message holds only entrant-supplied data and hashes."""
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code, self.msg = code, msg


def _env_int(name, default):
    v = int(os.environ.get(name, default))
    need(v > 0, f'{name} must be positive')
    return v


def _env_hosts(name, default):
    hosts = [h.strip().lower() for h in os.environ.get(name, default).split(',') if h.strip()]
    need(hosts and all(re.fullmatch(r'[a-z0-9-]+(\.[a-z0-9-]+)+', h) for h in hosts), f'{name}: bad host list')
    return tuple(hosts)


LIMITS = {
    'allowed_hosts': _env_hosts('ALLOWED_HOSTS', HF_HOST),
    'redirect_suffixes': _env_hosts('REDIRECT_SUFFIXES', 'huggingface.co,hf.co'),
    'max_weights_bytes': _env_int('MAX_WEIGHTS_BYTES', 20 * 1000 ** 3),
    'max_aux_bytes': _env_int('MAX_AUX_BYTES', 64 * 1000 ** 2),
    'max_shards': _env_int('MAX_SHARDS', 64),
    'max_body_bytes': _env_int('MAX_BODY_BYTES', 16 * 1000 ** 2),
    'socket_timeout_s': _env_int('SOCKET_TIMEOUT_S', 60),
    'download_timeout_s': _env_int('DOWNLOAD_TIMEOUT_S', 3 * 3600),
    'eval_timeout_s': _env_int('EVAL_TIMEOUT_S', 4 * 3600),
    'max_redirects': _env_int('MAX_REDIRECTS', 5),
    'architectures': sorted(ARCHS.values()),
    'dtypes': list(DTYPES),
    'max_items': MAX_ITEMS,
}
LIMITS_SHA256 = hashlib.sha256(canonical(LIMITS)).hexdigest()
WORK_DIR = os.environ.get('WORK_DIR', '/tmp/plumbline-weights')


def weights_digest(shards):
    """The statement's weights_sha256, exactly as the board enclave: one file -> its sha256; several shards ->
    sha256 of the sha256sum-style manifest '<sha256>  <file>\\n' per shard, in the order given."""
    if len(shards) == 1:
        return shards[0]['sha256']
    return hashlib.sha256(''.join(f"{s['sha256']}  {s['file']}\n" for s in shards).encode()).hexdigest()


def parse_payout(v):
    if not isinstance(v, str) or not re.fullmatch(r'[0-9a-f]{64}', v):
        raise Reject(400, 'payout must be 64 lowercase hex chars (the 32 raw bytes of a Solana pubkey)')
    if v == '0' * 64:
        raise Reject(400, 'payout must not be all zeros (the escrow never pays it)')
    return v


def check_url(url, hosts, suffix=False):
    """https only, no userinfo, no port; host equal to an allowed host (or, for redirects, a subdomain of one)."""
    try:
        u = urlparse(url)
        host, port = (u.hostname or '').lower(), u.port
    except ValueError:
        raise Reject(400, 'bad url')
    ok = any(host == h or (suffix and host.endswith('.' + h)) for h in hosts)
    if u.scheme != 'https' or u.username or u.password or port is not None or not ok:
        raise Reject(400, f'url host not allowed: {host or "?"} (allowed: {", ".join(hosts)})')
    return u


def hf_url(model_id, revision, name):
    return f'https://{HF_HOST}/{model_id}/resolve/{revision}/{name}'


def parse_request(req):
    if not isinstance(req, dict):
        raise Reject(400, 'body must be a JSON object')
    extra = set(req) - REQ_KEYS
    if extra:
        raise Reject(400, f'unexpected keys {sorted(extra)}')
    payout = parse_payout(req.get('payout'))
    c = req.get('challenge')
    if not isinstance(c, str) or not re.fullmatch(r'[0-9a-f]{64}', c):
        raise Reject(400, 'challenge must be 64 lowercase hex chars')
    sealed = req.get('sealed')
    try:
        need(isinstance(sealed, str) and sealed, 'empty')
        need(len(base64.b64decode(sealed, validate=True)) > 48, 'short')  # sealed box overhead is 48 bytes
    except Exception:
        raise Reject(400, 'sealed must be base64 of a suite sealed to the enclave key')
    mid, rev = req.get('model_id'), req.get('revision')
    if not isinstance(mid, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', mid) or '..' in mid:
        raise Reject(400, 'model_id must be <org>/<name>')
    if not isinstance(rev, str) or not re.fullmatch(r'[0-9a-f]{40}', rev):
        raise Reject(400, 'revision must be a 40-hex commit')
    dtype = req.get('dtype', 'bfloat16')
    if dtype not in DTYPES:
        raise Reject(400, f'dtype must be one of {DTYPES}')
    if 'weights' in req and 'shards' in req:
        raise Reject(400, 'give weights or shards, not both')
    items = req.get('weights', req.get('shards'))
    if not isinstance(items, list) or not 1 <= len(items) <= LIMITS['max_shards']:
        raise Reject(400, f'weights must be a list of 1..{LIMITS["max_shards"]} shards')
    shards = []
    for i, w in enumerate(items):
        if not isinstance(w, dict) or not ({'sha256'} < set(w) <= {'sha256', 'file', 'url', 'size'}) or ('file' in w) == ('url' in w):
            raise Reject(400, f'weights[{i}] must be {{file or url, sha256, size?}}')
        if not isinstance(w['sha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', w['sha256']):
            raise Reject(400, f'weights[{i}]: sha256 must be 64 lowercase hex chars')
        size = w.get('size')
        if size is not None and (isinstance(size, bool) or not isinstance(size, int) or size <= 0):
            raise Reject(400, f'weights[{i}]: size must be a positive integer')
        if 'file' in w:
            name, url = w['file'], None
            if not isinstance(name, str):
                raise Reject(400, f'weights[{i}]: bad file')
            if HF_HOST not in LIMITS['allowed_hosts']:
                raise Reject(400, f'weights[{i}]: {HF_HOST} is not an allowed host here; give a url')
        else:
            if not isinstance(w['url'], str) or len(w['url']) > 2048:
                raise Reject(400, f'weights[{i}]: bad url')
            u = check_url(w['url'], LIMITS['allowed_hosts'])
            name, url = unquote(u.path.rsplit('/', 1)[-1]), w['url']
        if not re.fullmatch(r'[A-Za-z0-9_.-]+\.safetensors', name) or name.startswith('.'):
            raise Reject(400, f'weights[{i}]: file name must be <name>.safetensors')
        shards.append({'file': name, 'sha256': w['sha256'], 'size': size,
                       'url': url or hf_url(mid, rev, name)})
    names = [s['file'] for s in shards]
    if len(set(names)) != len(names):
        raise Reject(400, 'duplicate shard file name')
    if len(shards) == 1 and names[0] != 'model.safetensors':
        raise Reject(400, 'a single-shard model must be model.safetensors')
    declared = sum(s['size'] or 0 for s in shards)
    if declared > LIMITS['max_weights_bytes']:
        raise Reject(413, f'declared weights {declared} bytes exceed the limit of {LIMITS["max_weights_bytes"]}')
    digest = weights_digest(shards)
    if req.get('weights_sha256') is not None and req['weights_sha256'] != digest:
        raise Reject(400, f'weights_sha256 does not match the shards (computed {digest})')
    return {'challenge': c, 'sealed': sealed, 'model_id': mid, 'revision': rev, 'dtype': dtype,
            'payout': payout, 'shards': shards, 'weights_sha256': digest}


# ---------- network: no automatic redirects, every hop checked ----------
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _open(url):
    """One HTTP GET, no redirect following. Returns (status, headers, readable)."""
    req = urllib.request.Request(url, headers={'User-Agent': 'plumbline-enclave/1'})
    try:
        r = _OPENER.open(req, timeout=LIMITS['socket_timeout_s'])
        return r.status, r.headers, r
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e


def http_get(url):
    check_url(url, LIMITS['allowed_hosts'])
    for _ in range(LIMITS['max_redirects'] + 1):
        status, headers, body = _open(url)
        if status in (301, 302, 303, 307, 308):
            loc = headers.get('Location') or ''
            body.close()
            url = urljoin(url, loc)
            check_url(url, LIMITS['redirect_suffixes'], suffix=True)
            continue
        return status, headers, body
    raise Reject(502, 'too many redirects')


def download(url, dest, max_bytes, deadline, label):
    """Streams url to dest. Returns (bytes, sha256 hex). Refuses more than max_bytes or past the deadline."""
    status, headers, body = http_get(url)
    try:
        if status != 200:
            raise Reject(502 if status != 404 else 422, f'{label}: HTTP {status}')
        cl = headers.get('Content-Length')
        if cl and cl.isdigit() and int(cl) > max_bytes:
            raise Reject(413, f'{label}: {cl} bytes exceeds the remaining limit of {max_bytes}')
        h, n = hashlib.sha256(), 0
        with open(dest, 'wb') as f:
            while True:
                if time.monotonic() > deadline:
                    raise Reject(504, f'{label}: download timed out')
                chunk = body.read(1 << 20)
                if not chunk:
                    break
                n += len(chunk)
                if n > max_bytes:
                    raise Reject(413, f'{label}: exceeds the remaining limit of {max_bytes} bytes')
                h.update(chunk)
                f.write(chunk)
        return n, h.hexdigest()
    finally:
        body.close()


def check_config(cfg, index, shards):
    if not isinstance(cfg, dict):
        raise Reject(422, 'config.json is not an object')
    if 'auto_map' in cfg:
        raise Reject(422, 'config.json asks for remote code (auto_map); not allowed')
    if cfg.get('quantization_config') is not None:
        raise Reject(422, 'quantized checkpoints are not supported')
    mt = cfg.get('model_type')
    if mt not in ARCHS or cfg.get('architectures') != [ARCHS[mt]]:
        raise Reject(422, f'architecture not allowed: model_type {mt!r}, architectures {cfg.get("architectures")!r} '
                          f'(allowed: {sorted(ARCHS.values())})')
    names = {s['file'] for s in shards}
    if len(shards) > 1:
        if not isinstance(index, dict) or not isinstance(index.get('weight_map'), dict):
            raise Reject(422, 'a sharded model needs model.safetensors.index.json at the revision')
        if set(index['weight_map'].values()) != names:
            raise Reject(422, 'model.safetensors.index.json names different shards than the request')


def fetch_and_verify(spec, d):
    """Caller holds EVAL_LOCK. Fetches config/tokenizer at model_id@revision and every weight shard into d,
    checking hosts, sizes, architecture and each shard's sha256. Returns the statement's weights_sha256."""
    deadline = time.monotonic() + LIMITS['download_timeout_s']
    for name in AUX_FILES:
        try:
            download(hf_url(spec['model_id'], spec['revision'], name), os.path.join(d, name),
                     LIMITS['max_aux_bytes'], deadline, name)
        except Reject as e:
            if e.code == 422 and name != 'config.json':  # 404: optional file absent
                continue
            raise
    for name in ('tokenizer_config.json',):
        p = os.path.join(d, name)
        if os.path.exists(p):
            try:
                tc = json.load(open(p))
            except ValueError:
                raise Reject(422, f'{name} is not JSON')
            if isinstance(tc, dict) and 'auto_map' in tc:
                raise Reject(422, f'{name} asks for remote code (auto_map); not allowed')
    try:
        cfg = json.load(open(os.path.join(d, 'config.json')))
        ip = os.path.join(d, 'model.safetensors.index.json')
        index = json.load(open(ip)) if os.path.exists(ip) else None
    except ValueError:
        raise Reject(422, 'config.json or the index is not JSON')
    check_config(cfg, index, spec['shards'])
    used = 0
    for s in spec['shards']:
        STATE['stage'] = f'downloading {s["file"]}'
        n, got = download(s['url'], os.path.join(d, s['file']), LIMITS['max_weights_bytes'] - used, deadline, s['file'])
        used += n
        if s['size'] is not None and n != s['size']:
            raise Reject(422, f'{s["file"]}: {n} bytes, declared size {s["size"]}')
        if got != s['sha256']:
            raise Reject(422, f'{s["file"]}: sha256 {got} != pinned {s["sha256"]}')
    present = sorted(f for f in os.listdir(d) if f.endswith('.safetensors'))
    need(present == sorted(s['file'] for s in spec['shards']), 'unexpected weights files')
    return weights_digest(spec['shards'])


def load_weights(path, spec):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    tok = AutoTokenizer.from_pretrained(path, trust_remote_code=False, local_files_only=True)
    if not getattr(tok, 'chat_template', None):
        raise Reject(422, 'tokenizer has no chat template')
    model = AutoModelForCausalLM.from_pretrained(path, torch_dtype=getattr(torch, spec['dtype']), use_safetensors=True,
                                                 trust_remote_code=False, local_files_only=True)
    if type(model).__name__ not in ARCHS.values():
        raise Reject(422, f'loaded class {type(model).__name__} is not allowed')
    model.eval()
    return tok, model


def boot():
    try:
        import torch
        import transformers  # noqa: F401  fail at boot, not at /enter, if the image is broken
        torch.set_num_threads(os.cpu_count() or 4)
        os.makedirs(WORK_DIR, exist_ok=True)
        STATE['ready'] = True
        print('competition enclave ready, limits sha256', LIMITS_SHA256, flush=True)
    except Exception:
        STATE['error'] = traceback.format_exc()
        print(STATE['error'], flush=True)


def get_quote(report_data):
    from dstack_sdk import DstackClient
    r = DstackClient().get_quote(report_data)
    q = r.quote if isinstance(r.quote, str) else bytes(r.quote).hex()
    return q, r.event_log


def answer(question):
    import torch
    tok, model = M['tok'], M['model']
    msgs = [{'role': 'system', 'content': 'Solve the problem step by step. Finish with a line: Answer: <integer>'},
            {'role': 'user', 'content': question}]
    ids = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors='pt')
    with torch.no_grad():
        out = model.generate(ids, max_new_tokens=256, do_sample=False)
    text = tok.decode(out[0][ids.shape[1]:], skip_special_tokens=True).replace(',', '')
    m = re.search(r'Answer:\s*(-?\d+)', text)
    if m:
        return m.group(1)
    nums = re.findall(r'-?\d+', text)
    return nums[-1] if nums else None


def prepare_model(spec, d):
    try:
        STATE['stage'] = 'fetching'
        digest = fetch_and_verify(spec, d)
        STATE['stage'] = 'loading'
        tok, model = load_weights(d, spec)
    except Reject:
        raise
    except Exception as e:  # the suite is still sealed here, so the cause can be logged
        print(traceback.format_exc(), flush=True)
        net = isinstance(e, (urllib.error.URLError, TimeoutError, ConnectionError))
        raise Reject(502 if net else 422, f'could not {"fetch" if net else "load"} the model: {type(e).__name__}')
    M.update(tok=tok, model=model, weights_sha256=digest)
    print('model ready', spec['model_id'], spec['revision'], digest, flush=True)


def evaluate(spec):
    """Caller holds EVAL_LOCK. Weights first, suite second: the suite is decrypted only after the weights are
    verified and loaded, and it never leaves this function."""
    d = tempfile.mkdtemp(dir=WORK_DIR)
    try:
        prepare_model(spec, d)
        STATE['stage'] = 'scoring'
        deadline = time.monotonic() + LIMITS['eval_timeout_s']
        suite_bytes = SealedBox(SK).decrypt(base64.b64decode(spec['sealed']))
        suite = json.loads(suite_bytes)
        items = suite['items'][:MAX_ITEMS]
        commitment = hashlib.sha256(canonical(suite)).hexdigest()
        correct = 0
        marks = []
        for it in items:
            if time.monotonic() > deadline:
                raise TimeoutError
            ok = answer(it['q']) == str(it['a']).strip()
            correct += ok
            marks.append('1' if ok else '0')
        statement = {
            'v': 'tessera-score-1',
            'suite_id': suite.get('suite_id', ''),
            'suite_commitment': commitment,
            'n': len(items),
            'correct': correct,
            'marks_sha256': hashlib.sha256((commitment + ''.join(marks)).encode()).hexdigest(),
            'model_id': spec['model_id'],
            'model_revision': spec['revision'],
            'weights_sha256': M['weights_sha256'],
            'challenge': spec['challenge'],
            'enclave_pubkey': PK.hex(),
            'payout': spec['payout'],
        }
        del suite, items, suite_bytes  # the suite never leaves this function
        rd = hashlib.sha256(b'tessera:score:v1' + canonical(statement)).digest()
        q, el = get_quote(rd)
        return {'statement': statement, 'quote': q, 'event_log': el, 'report_data': rd.hex()}
    finally:
        M.clear()
        gc.collect()
        shutil.rmtree(d, ignore_errors=True)  # weights never outlive the entry


class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == '/health':
            return self._send(200, {'ready': STATE['ready'], 'error': STATE['error'], 'mode': 'competition',
                                    'busy': STATE['busy'], 'stage': STATE['stage'], 'last_error': STATE['last_error'],
                                    'entries': STATE['entries'], 'limits': LIMITS, 'limits_sha256': LIMITS_SHA256,
                                    'enclave_pubkey': PK.hex()})
        if u.path == '/attest':
            c = parse_qs(u.query).get('challenge', [''])[0]
            if not re.fullmatch(r'[0-9a-f]{64}', c):
                return self._send(400, {'error': 'challenge must be 64 lowercase hex chars'})
            rd = hashlib.sha256(b'tessera:keyrelease:v1' + PK + bytes.fromhex(c)).digest()
            q, el = get_quote(rd)
            return self._send(200, {'enclave_pubkey': PK.hex(), 'challenge': c, 'report_data': rd.hex(),
                                    'quote': q, 'event_log': el, 'mode': 'competition',
                                    'limits_sha256': LIMITS_SHA256, 'ready': STATE['ready']})
        self._send(404, {'error': 'not found'})

    def do_POST(self):
        if urlparse(self.path).path != '/enter':
            return self._send(404, {'error': 'not found'})
        if not STATE['ready']:
            return self._send(503, {'error': 'not ready', 'detail': STATE['error']})
        try:
            n = int(self.headers.get('Content-Length', 0))
        except ValueError:
            return self._send(400, {'error': 'bad Content-Length'})
        if not 0 < n <= LIMITS['max_body_bytes']:
            return self._send(413 if n else 400, {'error': f'body must be 1..{LIMITS["max_body_bytes"]} bytes'})
        try:
            spec = parse_request(json.loads(self.rfile.read(n)))
        except Reject as e:
            return self._send(e.code, {'error': e.msg})
        except Exception:
            return self._send(400, {'error': 'body must be JSON'})
        if not EVAL_LOCK.acquire(blocking=False):
            return self._send(409, {'error': 'busy: one evaluation at a time, retry later'})
        try:
            STATE.update(busy=True, last_error=None)
            res = evaluate(spec)
            STATE['entries'] += 1
            return self._send(200, res)
        except Reject as e:  # raised only before the suite is decrypted
            STATE['last_error'] = e.msg
            print('entry refused:', e.msg, flush=True)
            return self._send(e.code, {'error': e.msg})
        except Exception as e:
            return self._send(500, {'error': type(e).__name__})  # no detail: it could echo suite content
        finally:
            STATE.update(busy=False, stage=None)
            EVAL_LOCK.release()

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    threading.Thread(target=boot, daemon=True).start()
    print('enclave pubkey', PK.hex(), flush=True)
    ThreadingHTTPServer(('0.0.0.0', 8080), H).serve_forever()
