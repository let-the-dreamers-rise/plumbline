"""Reference client for the competition enclave (the plumbline CLI does the same).
Sponsor, on their own machine (reads their own suite.json; never sends it in the clear):
    python compete_client.py seal https://<app-url> [--suite suite.json] [--out sealed.json] [--compose-hash <hex>]
  -> fresh challenge, key-release quote verified to Intel's root, suite sealed to the enclave key.
     sealed.json holds {challenge, enclave_pubkey, sealed, suite_id, suite_commitment, key_release, ...}: no
     questions or answers. Publish it with the bounty.
Entrant:
    python compete_client.py enter https://<app-url> sealed.json --model-id <org/name> --revision <40 hex>
        --weights weights.json --payout <64 hex> [--dtype bfloat16] [--out bundle.json]
  -> POST /enter, score quote verified, bundle written (verify_bundle.py / verify_compete.py format).
weights.json is a list of {file or url, sha256, size?}."""
import sys, json, base64, hashlib, urllib.request, urllib.error
from nacl.public import PublicKey, SealedBox
import tdxq
import tessera_eval as te


def intel_root():
    try:
        with urllib.request.urlopen(tdxq.INTEL_ROOT_URL, timeout=20) as r:
            return tdxq.load_intel_root(r.read())
    except Exception as e:
        print('  (could not fetch Intel root from Intel, using pinned fingerprint only:', type(e).__name__, ')')
        return None


def seal(base, suite, compose_hash=None, root=None):
    commitment = hashlib.sha256(te.canonical(suite)).hexdigest()
    challenge, src = te.solana_challenge()
    a = te.http(f'{base}/attest?challenge={challenge}')
    pk = bytes.fromhex(a['enclave_pubkey'])
    rd1 = hashlib.sha256(b'tessera:keyrelease:v1' + pk + bytes.fromhex(challenge)).hexdigest()
    m1 = te.check_quote('key quote', a['quote'], a['event_log'], rd1, root)
    if compose_hash:
        assert m1['compose_hash'] == compose_hash, f'enclave compose hash {m1["compose_hash"]} != expected {compose_hash}'
    sealed = base64.b64encode(SealedBox(PublicKey(pk)).encrypt(json.dumps(suite).encode())).decode()
    return {'challenge': challenge, 'challenge_source': src, 'enclave_pubkey': a['enclave_pubkey'], 'sealed': sealed,
            'suite_id': suite['suite_id'], 'suite_commitment': commitment, 'limits_sha256': a.get('limits_sha256'),
            'key_release': {'quote': a['quote'], 'event_log': a['event_log'], 'report_data': rd1},
            'measurements': {'mr_td': m1['mr_td'], 'rtmr': m1['rtmr'], 'compose_hash': m1['compose_hash']}}


def post(url, body, timeout):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')


def enter(base, s, model_id, revision, weights, payout, dtype=None, root=None, timeout=8 * 3600):
    body = {'challenge': s['challenge'], 'sealed': s['sealed'], 'model_id': model_id, 'revision': revision,
            'weights': weights, 'payout': payout}
    if dtype:
        body['dtype'] = dtype
    code, res = post(base + '/enter', body, timeout)
    if code != 200:
        raise SystemExit(f'enclave refused the entry: HTTP {code}: {res.get("error")}')
    st = res['statement']
    assert st.get('v') == 'tessera-score-1'
    rd2 = hashlib.sha256(b'tessera:score:v1' + te.canonical(st)).hexdigest()
    kr = s['key_release']
    m1 = te.check_quote('key quote', kr['quote'], kr['event_log'], kr['report_data'], root)
    m2 = te.check_quote('score quote', res['quote'], res['event_log'], rd2, root)
    assert (m2['mr_td'], m2['rtmr']) == (m1['mr_td'], m1['rtmr']), 'score came from a different enclave'
    assert st['enclave_pubkey'] == s['enclave_pubkey'] and st['challenge'] == s['challenge']
    assert st['suite_commitment'] == s['suite_commitment'], 'enclave scored a different suite'
    assert (st['model_id'], st['model_revision'], st['payout']) == (model_id, revision, payout)
    return {'statement': st, 'statement_sha256': hashlib.sha256(te.canonical(st)).hexdigest(),
            'challenge_source': s.get('challenge_source'), 'key_release': kr,
            'score': {'quote': res['quote'], 'event_log': res['event_log'], 'report_data': rd2},
            'measurements': {'mr_td': m1['mr_td'], 'rtmr': m1['rtmr'], 'compose_hash': m1['compose_hash']}}


def main():
    a = sys.argv[1:]
    opt = lambda k, d=None: a[a.index(k) + 1] if k in a else d
    cmd, base = a[0], a[1].rstrip('/')
    if cmd == 'seal':
        s = seal(base, json.load(open(opt('--suite', 'suite.json'))), opt('--compose-hash'), intel_root())
        out = opt('--out', 'sealed.json')
        json.dump(s, open(out, 'w'), indent=1)
        print(f'wrote {out}: suite {s["suite_id"]} sealed to enclave {s["enclave_pubkey"][:16]}... (no questions inside)')
    elif cmd == 'enter':
        b = enter(base, json.load(open(a[2])), opt('--model-id'), opt('--revision'), json.load(open(opt('--weights'))),
                  opt('--payout'), opt('--dtype'), intel_root())
        out = opt('--out', 'bundle.json')
        json.dump(b, open(out, 'w'), indent=1)
        st = b['statement']
        print(f'{st["correct"]}/{st["n"]} correct; wrote {out}. Verify: python verify_compete.py {out}')
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main()
