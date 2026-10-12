"""Anyone can check a Tessera score bundle offline: python verify_bundle.py bundle-<id>.json [--require-gpu]
Checks both TDX quotes to Intel's root, that the key-release quote binds the enclave key and challenge,
that the score quote binds this exact statement, that both came from the same measured enclave,
and prints the memo to compare with the Solana devnet transaction.
GPU (v2) bundles, recognised by a gpu section / statement v 'tessera-score-2', also get: the NVIDIA GPU
report and its 5-cert chain verified to NVIDIA's pinned Device Identity CA, its requester nonce equal to
sha256(canonical(statement)), and the score quote's report_data equal to
sha256('tessera:score:v2' || canonical(statement) || sha256(gpu_report))."""
import sys, json, hashlib
import tdxq, gpuq


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def verify(b, require_gpu=False, nv_root_pem=None, log=print):
    st = b['statement']
    gpu = b.get('gpu')
    v2 = gpu is not None or st.get('v') == 'tessera-score-2' or b['score'].get('binding') == 'tessera:score:v2'
    g = None
    rd1 = hashlib.sha256(b'tessera:keyrelease:v1' + bytes.fromhex(st['enclave_pubkey']) + bytes.fromhex(st['challenge'])).hexdigest()
    if v2:
        assert gpu is not None, 'v2 statement but the bundle has no gpu section'
        assert st.get('v') == 'tessera-score-2', 'gpu section on a statement that is not tessera-score-2'
        g = gpuq.check_gpu_section(gpu, canonical(st), root_pem=nv_root_pem)
        rd2 = gpuq.score_report_data_v2(canonical(st), bytes.fromhex(gpu['report']))
        log(f'GPU report OK: NVIDIA Device Identity CA, nonce = statement digest, device {g["device_id"]}, '
            f'driver {g["driver_version"]}, VBIOS {g["vbios_version"]}')
    else:
        assert not require_gpu, 'CPU-only (v1) bundle, but a GPU-bound score was required'
        rd2 = hashlib.sha256(b'tessera:score:v1' + canonical(st)).hexdigest()
    ms = []
    for label, part, rd in (('key-release', b['key_release'], rd1), ('score', b['score'], rd2)):
        m = tdxq.verify_quote(bytes.fromhex(part['quote']))
        assert m['report_data'][:64] == rd, f'{label} quote does not bind its statement'
        r3, events, _ = tdxq.replay_rtmr3(part['event_log'])
        assert r3 == m['rtmr'][3], f'{label} event log does not replay to RTMR3'
        m['compose_hash'] = tdxq.compose_hash(events)
        ms.append(m)
        log(f'{label} quote OK: Intel root, report_data bound, RTMR3 replayed')
    assert (ms[0]['mr_td'], ms[0]['rtmr']) == (ms[1]['mr_td'], ms[1]['rtmr']), 'quotes come from different enclaves'
    assert hashlib.sha256(canonical(st)).hexdigest() == b['statement_sha256']
    version = 'v2' if v2 else 'v1'
    log(f'score {st["correct"]}/{st["n"]} for {st["model_id"]}@{st["model_revision"][:10]} on suite {st["suite_id"]} ({st["suite_commitment"][:16]}...)'
        + (' [GPU-bound, v2]' if v2 else ' [CPU-only, v1]'))
    log(f'enclave app compose hash {ms[0]["compose_hash"]} (compare with sha256 of the published app-compose)')
    log(f'expected Solana memo: tessera:score:{version}:{b["statement_sha256"]}:{st["correct"]}/{st["n"]}')
    if b.get('solana_devnet_signature'):
        log(f'https://explorer.solana.com/tx/{b["solana_devnet_signature"]}?cluster=devnet')
    return {'version': version, 'quotes': ms, 'gpu': g}


if __name__ == '__main__':
    verify(json.load(open([a for a in sys.argv[1:] if not a.startswith('--')][0])), require_gpu='--require-gpu' in sys.argv)
