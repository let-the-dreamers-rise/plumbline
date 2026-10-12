"""Competition flow end to end with the mocked enclave: sponsor seals once, entrants enter arbitrary models with
their own payout, bundles verify; and the limits that guard the enclave (payout format, host allowlist, size,
per-shard sha256, architecture, one evaluation at a time, suite decrypted only after the weights are ready)."""
import os, copy, json, base64, hashlib, threading, time, types, urllib.request, urllib.error
from _mocks import *
install_fake_dstack()
from _e2e_compete import *
import server, verify_bundle, verify_compete, compete_client, gen_suite

V1_KEYS = {'v', 'suite_id', 'suite_commitment', 'n', 'correct', 'marks_sha256', 'model_id', 'model_revision',
           'weights_sha256', 'challenge', 'enclave_pubkey'}  # the board's statement fields
DECRYPTS = []
_RealBox = server.SealedBox


class CountingBox(_RealBox):
    def decrypt(self, *a, **k):
        DECRYPTS.append(1)
        return super().decrypt(*a, **k)
server.SealedBox = CountingBox

items = [gen_suite.item() for _ in range(6)]
suite = {'suite_id': 'plumbline-test-0001', 'salt': '00' * 32, 'items': items}
A, B, C = 'test-org/single-a', 'test-org/sharded-b', 'other-org/mirror-c'
RA, RB, RC = 'a' * 40, 'b' * 40, 'c' * 40
answers = {A: {it['q']: it['a'] for it in items[:2]}, B: {it['q']: it['a'] for it in items[:5]},
           C: {it['q']: it['a'] for it in items[:3]}}
WA = publish_model(A, RA, [('model.safetensors', R(4096, b'a'))])
WB = publish_model(B, RB, [('model-00001-of-00002.safetensors', R(4096, b'b1')),
                           ('model-00002-of-00002.safetensors', R(1024, b'b2'))])
base = start_enclave(server, answers)
offline_client()
PAY1, PAY2 = '11' * 32, 'ab' * 32

print('sponsor seals the suite once')
with quote_shim():
    S = compete_client.seal(base, suite)
check(set(S) >= {'challenge', 'sealed', 'enclave_pubkey', 'key_release', 'suite_commitment'} and 'items' not in json.dumps(S),
      'sealed.json carries the key release and the sealed suite, no questions')
check(not DECRYPTS, 'nothing decrypted at seal time')

print('entrant A (single shard, file form)')
with quote_shim():
    bA = compete_client.enter(base, S, A, RA, WA, PAY1)
stA = bA['statement']
check(set(stA) == V1_KEYS | {'payout'} and stA['v'] == 'tessera-score-1', 'statement = the board fields + payout')
check(stA['payout'] == PAY1 and stA['correct'] == 2 and stA['n'] == 6, 'payout and score as entered')
check(stA['weights_sha256'] == WA[0]['sha256'], 'single shard: weights_sha256 = its sha256 (as the board)')
rd = hashlib.sha256(b'tessera:score:v1' + canonical(stA)).digest()
check(rd in DSTACK_CALLS and bA['score']['report_data'] == rd.hex(), 'report_data = sha256("tessera:score:v1" || canonical(statement with payout))')
no_pay = {k: v for k, v in stA.items() if k != 'payout'}
check(hashlib.sha256(b'tessera:score:v1' + canonical(no_pay)).digest() not in DSTACK_CALLS, 'payout is inside report_data (statement without it was never quoted)')
check(not os.listdir(server.WORK_DIR), 'weights deleted after the entry')

print('entrant B (two shards, board "shards" form, weights_sha256 given)')
dB = hashlib.sha256(''.join(f"{s['sha256']}  {s['file']}\n" for s in WB).encode()).hexdigest()
code, res = compete_client.post(base + '/enter', {'challenge': S['challenge'], 'sealed': S['sealed'], 'model_id': B,
                                'revision': RB, 'shards': WB, 'dtype': 'float32', 'weights_sha256': dB, 'payout': PAY2}, 60)
check(code == 200 and res['statement']['weights_sha256'] == dB and res['statement']['payout'] == PAY2 and res['statement']['correct'] == 5,
      'two shards: weights_sha256 = sha256 of the manifest (as the board); score 5/6')

print('entrant C (url form, redirect to a CDN subdomain)')
data_c = R(2048, b'c')
publish_model(C, RC, [('model.safetensors', b'')])
src = 'https://huggingface.co/test-org/single-a-mirror/resolve/main/model.safetensors'
redirect(src, 'https://cdn-lfs.hf.co/blob/xyz')
put('https://cdn-lfs.hf.co/blob/xyz', data_c)
with quote_shim():
    bC = compete_client.enter(base, S, C, RC, [{'url': src, 'sha256': hashlib.sha256(data_c).hexdigest(), 'size': len(data_c)}], PAY1)
check(bC['statement']['correct'] == 3, 'url weights fetched through an allowed redirect and scored')

print('bundles verify, payout checked')
with quote_shim():
    for b in (bA, bC):
        check(verify_bundle.verify(b, log=lambda *a: None)['version'] == 'v1', 'unchanged verify_bundle accepts the bundle')
        check(verify_compete.verify(b, payout=b['statement']['payout'], suite_commitment=S['suite_commitment'], log=lambda *a: None)['payout']
              == b['statement']['payout'], 'verify_compete accepts and returns the payout')
    t = copy.deepcopy(bA); t['statement']['payout'] = PAY2
    t['statement_sha256'] = hashlib.sha256(canonical(t['statement'])).hexdigest()
    rejects(lambda: verify_compete.verify(t, log=lambda *a: None), 'payout swapped in the bundle (quote no longer binds it)')
    rejects(lambda: verify_compete.verify(bA, payout=PAY2, log=lambda *a: None), 'payout differs from the expected one')
    rejects(lambda: verify_compete.verify(bA, compose_hash='00' * 32, log=lambda *a: None), 'different expected compose hash')
    for bad_p, what in ((None, 'missing'), ('AB' * 32, 'uppercase'), ('00' * 32, 'all zeros'), ('11' * 31, 'short')):
        st = {k: v for k, v in stA.items() if k != 'payout'}
        if bad_p is not None:
            st['payout'] = bad_p
        q = install_fake_dstack().DstackClient().get_quote(hashlib.sha256(b'tessera:score:v1' + canonical(st)).digest())
        nb = dict(bA, statement=st, statement_sha256=hashlib.sha256(canonical(st)).hexdigest(),
                  score={'quote': q.quote, 'event_log': q.event_log, 'report_data': ''})
        verify_bundle.verify(nb, log=lambda *a: None)  # a validly quoted v1 statement...
        rejects(lambda: verify_compete.verify(nb, log=lambda *a: None), f'...but its payout is {what}')
check(verify_compete.base58(bytes(32)) == '1' * 32 and verify_compete.base58(b'\0\x01') == '12', 'base58 display')


def post(body, raw=None):
    try:
        r = urllib.request.urlopen(urllib.request.Request(base + '/enter', data=raw or json.dumps(body).encode()))
        return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def entry(**k):
    b = {'challenge': S['challenge'], 'sealed': S['sealed'], 'model_id': A, 'revision': RA, 'weights': WA, 'payout': PAY1}
    b.update(k)
    return {x: y for x, y in b.items() if y is not None}


def refused(body, want, msg, contains=None):
    n_q, n_d, n_o = len(DSTACK_CALLS), len(DECRYPTS), len(OPEN_CALLS)
    code, res = post(body)
    check(code == want and len(DSTACK_CALLS) == n_q and len(DECRYPTS) == n_d and (contains is None or contains in res['error']),
          f'{msg}: HTTP {code}, no quote, suite not decrypted')
    return n_o


print('payout is required and well-formed')
for p, what in ((None, 'missing'), ('AB' * 32, 'uppercase hex'), ('11' * 31, '62 chars'), ('11' * 33, '66 chars'),
                ('4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T', 'base58 string'), ('00' * 32, 'all zeros'),
                (12345, 'a number'), ('g' * 64, 'not hex')):
    n_o = refused(entry(payout=p), 400, f'payout {what} rejected', 'payout')
    check(len(OPEN_CALLS) == n_o, '  ...before any download')

print('request validation')
refused(entry(challenge='AA' * 32), 400, 'uppercase challenge')
refused(entry(revision='main'), 400, 'revision not a commit')
refused(entry(model_id='../etc'), 400, 'bad model_id')
refused(entry(dtype='int8'), 400, 'unknown dtype')
refused(entry(sealed='not base64!'), 400, 'sealed not base64')
refused(entry(weights=[{'file': '../x.safetensors', 'sha256': WA[0]['sha256']}]), 400, 'shard path outside the snapshot')
refused(entry(weights=[{'file': 'model.bin', 'sha256': WA[0]['sha256']}]), 400, 'non-safetensors weights')
refused(entry(weights=[{'file': 'model.safetensors', 'sha256': 'AB' * 32}]), 400, 'shard sha256 not lowercase hex')
refused(entry(weights=[dict(WA[0], url=hf(A, RA, 'model.safetensors'))]), 400, 'both file and url')
refused(entry(weights=[]), 400, 'no shards')
refused(entry(weights=[{'file': 'other.safetensors', 'sha256': WA[0]['sha256']}]), 400, 'single shard not named model.safetensors')
refused(entry(weights=WB + WB), 400, 'duplicate shards')
refused(entry(weights_sha256='00' * 32), 400, 'weights_sha256 that does not match the shards')
refused(entry(extra=1), 400, 'unexpected key')
code, _ = post(None, raw=b'{not json'); check(code == 400, 'non-JSON body rejected')

print('host allowlist')
for u, what in (('https://evil.example/model.safetensors', 'other host'), ('http://huggingface.co/x/model.safetensors', 'plain http'),
                ('https://huggingface.co:8443/x/model.safetensors', 'explicit port'), ('https://u:p@huggingface.co/x/model.safetensors', 'userinfo'),
                ('https://huggingface.co.evil.example/model.safetensors', 'lookalike host'), ('https://cdn-lfs.hf.co/model.safetensors', 'redirect-only host given directly'),
                ('file:///etc/model.safetensors', 'file url')):
    n_o = refused(entry(weights=[{'url': u, 'sha256': WA[0]['sha256']}]), 400, f'{what} rejected', 'not allowed')
    check(len(OPEN_CALLS) == n_o, '  ...without connecting')
src2 = 'https://huggingface.co/x/y/resolve/main/model.safetensors'
redirect(src2, 'https://169.254.169.254/latest/meta-data')
refused(entry(weights=[{'url': src2, 'sha256': WA[0]['sha256']}]), 400, 'redirect to a disallowed host refused', 'not allowed')
check('https://169.254.169.254/latest/meta-data' not in OPEN_CALLS, '  ...and never followed')
redirect(src2, 'https://huggingface.co/x/y/resolve/main/model.safetensors')
refused(entry(weights=[{'url': src2, 'sha256': WA[0]['sha256']}]), 502, 'redirect loop stops', 'too many redirects')

print('size limits')
refused(entry(weights=[dict(WA[0], size=server.LIMITS['max_weights_bytes'] + 1)]), 413, 'declared size over the limit, before download')
real_max = server.LIMITS['max_weights_bytes']
server.LIMITS['max_weights_bytes'] = 4000
refused(entry(), 413, 'served shard larger than the limit (Content-Length)', 'exceeds')
url_a = hf(A, RA, 'model.safetensors'); st_, hd_, bd_ = WEB[url_a]
WEB[url_a] = (200, {}, bd_)  # no Content-Length: the streaming count must catch it
refused(entry(), 413, 'served shard larger than the limit (streamed, no Content-Length)', 'exceeds')
WEB[url_a] = (st_, hd_, bd_)
server.LIMITS['max_weights_bytes'] = 4096 + 1024 - 1
refused(entry(model_id=B, revision=RB, weights=WB), 413, 'total across shards over the limit')
server.LIMITS['max_weights_bytes'] = real_max
refused(entry(weights=[dict(WA[0], size=4095)]), 422, 'served size differs from the declared size')

print('per-shard sha256')
refused(entry(weights=[{'file': 'model.safetensors', 'sha256': 'ee' * 32}]), 422, 'shard sha256 differs from the pin', 'sha256')
check('sha256' in server.STATE['last_error'], 'reason shown in /health last_error (no suite involved yet)')
bad = [WB[0], dict(WB[1], sha256='ee' * 32)]
refused(entry(model_id=B, revision=RB, weights=bad), 422, 'one bad shard of a sharded model', 'model-00002-of-00002.safetensors')
refused(entry(model_id=B, revision=RB, weights=WB[:1] + [{'file': 'model-00003-of-00002.safetensors', 'sha256': WB[1]['sha256']}]), 422,
        'shard set differs from the index')
check(not os.listdir(server.WORK_DIR), 'failed entries leave no weights on disk')

print('architecture allowlist, no remote code')
for mid, cfg, what in (('t/gpt', {'model_type': 'gpt2', 'architectures': ['GPT2LMHeadModel']}, 'unlisted architecture'),
                       ('t/mix', {'model_type': 'llama', 'architectures': ['MistralForCausalLM']}, 'type/class mismatch'),
                       ('t/rc', dict(CFG, auto_map={'AutoModelForCausalLM': 'm.M'}), 'auto_map in config'),
                       ('t/q', dict(CFG, quantization_config={'quant_method': 'gptq'}), 'quantized')):
    w = publish_model(mid, 'e' * 40, [('model.safetensors', R(64, b'x'))], cfg=cfg)
    n_o = refused(entry(model_id=mid, revision='e' * 40, weights=w), 422, f'{what} rejected')
    check(hf(mid, 'e' * 40, 'model.safetensors') not in OPEN_CALLS, '  ...before downloading weights')
w = publish_model('t/tk', 'e' * 40, [('model.safetensors', R(64, b'x'))], tok_cfg={'auto_map': {'AutoTokenizer': ['t.T', None]}})
refused(entry(model_id='t/tk', revision='e' * 40, weights=w), 422, 'auto_map in tokenizer_config rejected')
refused(entry(model_id='t/none', revision='e' * 40, weights=w), 422, 'no config.json at the revision')
calls = {}
fake_torch = types.ModuleType('torch'); fake_torch.float32, fake_torch.bfloat16 = 'f32', 'bf16'
fake_tf = types.ModuleType('transformers')


class Tok:
    chat_template = 't'
    @classmethod
    def from_pretrained(cls, p, **k): calls['tok'] = k; return cls()


class LlamaForCausalLM:
    def eval(self): pass


class Auto:
    @staticmethod
    def from_pretrained(p, **k): calls['model'] = k; return LlamaForCausalLM()
fake_tf.AutoTokenizer, fake_tf.AutoModelForCausalLM = Tok, Auto
sys.modules['torch'], sys.modules['transformers'] = fake_torch, fake_tf
import importlib.util
spec_ = importlib.util.spec_from_file_location('server_src', os.path.join(ROOT, 'enclave', 'server.py'))
fresh = importlib.util.module_from_spec(spec_); spec_.loader.exec_module(fresh)
fresh.load_weights('/nowhere', {'dtype': 'bfloat16'})
check(calls['tok'].get('trust_remote_code') is False and calls['model'].get('trust_remote_code') is False
      and calls['model'].get('use_safetensors') is True and calls['model'].get('torch_dtype') == 'bf16'
      and calls['tok'].get('local_files_only') and calls['model'].get('local_files_only'),
      'real load_weights: trust_remote_code=False, safetensors only, local files only, requested dtype')
Auto.from_pretrained = staticmethod(lambda p, **k: type('GPT2LMHeadModel', (), {'eval': lambda s: None})())
rejects(lambda: fresh.load_weights('/nowhere', {'dtype': 'float32'}), 'loaded class not on the allowlist')
del sys.modules['torch'], sys.modules['transformers']

print('one evaluation at a time')
gate = threading.Event()
GATES[url_a] = gate
out = {}
t = threading.Thread(target=lambda: out.update(r=post(entry())))
t.start()
for _ in range(200):
    if server.STATE['busy']:
        break
    time.sleep(0.01)
check(server.STATE['busy'], 'first entry is running')
code, res = post(entry(payout=PAY2))
check(code == 409 and 'busy' in res['error'], 'concurrent /enter gets 409')
h = json.loads(urllib.request.urlopen(base + '/health').read())
check(h['busy'] is True and not any(it['q'] in json.dumps(h) for it in items), '/health reports busy, nothing about the suite')
gate.set(); t.join(30); del GATES[url_a]
check(out['r'][0] == 200 and out['r'][1]['statement']['payout'] == PAY1, 'first entry finishes with its own payout')
code, res = post(entry(payout=PAY2))
check(code == 200 and res['statement']['payout'] == PAY2, 'next entry is accepted once the enclave is free')

print('after decryption nothing leaks')
real_answer = server.answer
server.answer = lambda q: (_ for _ in ()).throw(ValueError('model choked on: ' + q))
n_q = len(DSTACK_CALLS)
code, res = post(entry())
check(code == 500 and res == {'error': 'ValueError'} and len(DSTACK_CALLS) == n_q, 'error while scoring: type name only, no quote')
check(not any(it['q'] in json.dumps(server.STATE) for it in items), 'question text not kept in STATE')
server.answer = real_answer
server.LIMITS['eval_timeout_s'] = 0
code, res = post(entry())
check(code == 500 and res == {'error': 'TimeoutError'} and len(DSTACK_CALLS) == n_q, 'eval timeout: no score, no quote')
server.LIMITS['eval_timeout_s'] = 14400
order = []
real_prep = server.prepare_model
server.prepare_model = lambda *a: (order.append('weights'), real_prep(*a))
server.SealedBox = type('B', (CountingBox,), {'decrypt': lambda s, *a: (order.append('decrypt'), CountingBox.decrypt(s, *a))[1]})
code, _ = post(entry())
check(code == 200 and order == ['weights', 'decrypt'], 'suite decrypted only after the weights are verified and loaded')
server.prepare_model = real_prep

print('GET endpoints')
h = json.loads(urllib.request.urlopen(base + '/health').read())
check(h['mode'] == 'competition' and h['limits']['allowed_hosts'] == ['huggingface.co'] and h['limits']['max_weights_bytes'] == 20 * 10 ** 9
      and h['limits_sha256'] == hashlib.sha256(canonical(h['limits'])).hexdigest(), '/health shows the limits and their hash')
try:
    urllib.request.urlopen(base + '/attest?challenge=zz')
    raise AssertionError('bad challenge accepted')
except urllib.error.HTTPError as e:
    check(e.code == 400, '/attest rejects a bad challenge')
for p in ('/evaluate', '/load'):
    try:
        urllib.request.urlopen(urllib.request.Request(base + p, data=b'{}'))
        raise AssertionError(p)
    except urllib.error.HTTPError as e:
        check(e.code == 404, f'board endpoint {p} is gone')
print('PASS test_compete_e2e')
