"""Tessera sealed eval, suite-owner side. Run on your own machine:
    python tessera_eval.py https://<your-phala-app-url> [--require-gpu]
Steps: fresh challenge (Solana devnet blockhash) -> enclave attests its key -> verify the TDX quote
to Intel's root and the key binding -> encrypt suite.json to that key -> enclave scores the model ->
verify the second quote binds the score -> anchor the statement hash on Solana devnet -> write bundle."""
import sys, os, json, time, base64, hashlib, secrets, subprocess, shutil, urllib.request
from nacl.public import PublicKey, SealedBox
import tdxq, gpuq


def http(url, data=None, timeout=60):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def solana_challenge():
    try:
        r = http('https://api.devnet.solana.com', {'jsonrpc': '2.0', 'id': 1, 'method': 'getLatestBlockhash',
                                                    'params': [{'commitment': 'finalized'}]}, timeout=20)
        bh, slot = r['result']['value']['blockhash'], r['result']['context']['slot']
        c = hashlib.sha256(b'tessera:challenge:v1' + bh.encode() + secrets.token_bytes(16)).hexdigest()
        return c, {'source': 'solana-devnet', 'blockhash': bh, 'slot': slot}
    except Exception as e:
        print('  (devnet unreachable, using a random challenge:', type(e).__name__, ')')
        return secrets.token_hex(32), {'source': 'random'}


def check_quote(label, quote_hex, event_log, expected_rd, intel_root):
    m = tdxq.verify_quote(bytes.fromhex(quote_hex), intel_root)
    assert m['report_data'][:64] == expected_rd, f'{label}: report_data does not bind the expected value'
    rtmr3, events, formula_ok = tdxq.replay_rtmr3(event_log)
    assert rtmr3 == m['rtmr'][3], f'{label}: event log does not replay to the quoted RTMR3'
    m['compose_hash'] = tdxq.compose_hash(events)
    m['event_digest_formula_ok'] = formula_ok
    print(f'  {label}: TDX quote verified to Intel root ({m["intel_root_pinned"]}), report_data bound, RTMR3 replayed')
    print(f'    mr_td {m["mr_td"][:24]}...  compose_hash {m["compose_hash"]}')
    return m


def anchor(statement_hash, score_text, version='v1'):
    memo = f'tessera:score:{version}:{statement_hash}:{score_text}'
    sol = shutil.which('solana')
    if not sol:
        print('  solana CLI not found; anchor manually with memo:', memo)
        return None
    me = subprocess.run([sol, 'address'], capture_output=True, text=True).stdout.strip()
    r = subprocess.run([sol, 'transfer', me, '0.000001', '--allow-unfunded-recipient', '--with-memo', memo,
                        '--url', 'devnet', '--output', 'json'], capture_output=True, text=True)
    if r.returncode != 0:
        print('  anchoring failed:', r.stderr.strip()[:300], '\n  memo was:', memo)
        return None
    sig = json.loads(r.stdout).get('signature')
    print(f'  anchored: https://explorer.solana.com/tx/{sig}?cluster=devnet')
    return sig


def main():
    args = [x for x in sys.argv[1:] if not x.startswith('--')]
    require_gpu = '--require-gpu' in sys.argv  # refuse a CPU-only (v1) score
    base = args[0].rstrip('/')
    suite = json.load(open('suite.json'))
    commitment = hashlib.sha256(canonical(suite)).hexdigest()
    print(f'suite {suite["suite_id"]}: {len(suite["items"])} items, commitment {commitment}')

    intel_root = None
    try:
        with urllib.request.urlopen(tdxq.INTEL_ROOT_URL, timeout=20) as r:
            intel_root = tdxq.load_intel_root(r.read())
    except Exception as e:
        print('  (could not fetch Intel root from Intel, using pinned fingerprint only:', type(e).__name__, ')')

    print('1. waiting for the enclave model to load')
    while True:
        h = http(base + '/health')
        if h['ready']:
            break
        if h['error']:
            sys.exit('enclave failed to load model:\n' + h['error'])
        time.sleep(10)
    print(f'  model {h["model_id"]}@{h["model_revision"][:10]} weights sha256 {h["weights_sha256"][:16]}...')

    print('2. key-release attestation')
    challenge, chal_src = solana_challenge()
    a = http(f'{base}/attest?challenge={challenge}')
    pk = bytes.fromhex(a['enclave_pubkey'])
    rd1 = hashlib.sha256(b'tessera:keyrelease:v1' + pk + bytes.fromhex(challenge)).hexdigest()
    m1 = check_quote('key quote', a['quote'], a['event_log'], rd1, intel_root)

    print('3. sealing the suite to the enclave key and evaluating (CPU model, takes a few minutes)')
    sealed = base64.b64encode(SealedBox(PublicKey(pk)).encrypt(json.dumps(suite).encode())).decode()
    t0 = time.time()
    res = http(base + '/evaluate', {'challenge': challenge, 'sealed': sealed}, timeout=3600)
    st = res['statement']
    print(f'  done in {time.time() - t0:.0f}s: {st["correct"]}/{st["n"]} correct')

    print('4. verifying the score quote')
    gpu = res.get('gpu')
    if gpu is not None or st.get('v') == 'tessera-score-2':
        assert gpu is not None and st.get('v') == 'tessera-score-2', 'GPU statement without GPU evidence, or the reverse'
        g = gpuq.check_gpu_section(gpu, canonical(st))
        print(f'  GPU report verified to NVIDIA Device Identity CA, nonce = statement digest; device {g["device_id"]}, '
              f'driver {g["driver_version"]}, VBIOS {g["vbios_version"]}')
        rd2 = gpuq.score_report_data_v2(canonical(st), bytes.fromhex(gpu['report']))
        version = 'v2'
    else:
        assert not require_gpu, 'enclave returned a CPU-only (v1) score but --require-gpu was given'
        rd2 = hashlib.sha256(b'tessera:score:v1' + canonical(st)).hexdigest()
        version = 'v1'
    m2 = check_quote('score quote', res['quote'], res['event_log'], rd2, intel_root)
    assert (m2['mr_td'], m2['rtmr']) == (m1['mr_td'], m1['rtmr']), 'score came from a different enclave'
    assert st['enclave_pubkey'] == a['enclave_pubkey'] and st['challenge'] == challenge
    assert st['suite_commitment'] == commitment, 'enclave scored a different suite'
    assert st['model_revision'] == h['model_revision'] and st['weights_sha256'] == h['weights_sha256']

    print('5. anchoring on Solana devnet')
    statement_hash = hashlib.sha256(canonical(st)).hexdigest()
    sig = anchor(statement_hash, f'{st["correct"]}/{st["n"]}', version)

    bundle = {'statement': st, 'statement_sha256': statement_hash, 'challenge_source': chal_src,
              'key_release': {'quote': a['quote'], 'event_log': a['event_log'], 'report_data': rd1},
              'score': {'quote': res['quote'], 'event_log': res['event_log'], 'report_data': rd2},
              'measurements': {'mr_td': m1['mr_td'], 'rtmr': m1['rtmr'], 'compose_hash': m1['compose_hash'],
                               'event_digest_formula_ok': m1['event_digest_formula_ok']},
              'solana_devnet_signature': sig}
    if version == 'v2':
        bundle['score']['binding'] = 'tessera:score:v2'
        bundle['gpu'] = {'report': gpu['report'], 'cert_chain': gpu['cert_chain'], 'nonce': gpu['nonce'],
                         'report_sha256': g['report_sha256'], 'device_id': g['device_id'],
                         'driver_version': g['driver_version'], 'vbios_version': g['vbios_version']}
    out = f'bundle-{st["suite_id"]}.json'
    json.dump(bundle, open(out, 'w'), indent=1)
    print(f'wrote {out} (public: no questions or answers inside). Verify anywhere: python verify_bundle.py {out}')


if __name__ == '__main__':
    main()
