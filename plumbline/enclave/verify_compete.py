"""Anyone can check a Plumbline competition score bundle offline:
    python verify_compete.py bundle.json [--payout <64 hex>] [--compose-hash <hex>] [--suite-commitment <hex>]
Runs the unchanged verify_bundle.verify (both TDX quotes to Intel's root, key-release and score bindings, same
enclave, RTMR3 replay), then the competition checks: the statement is tessera-score-1 and carries `payout`,
64 lowercase hex chars (the 32 raw bytes of a Solana pubkey), not all zeros. Because report_data =
sha256("tessera:score:v1" || canonical(statement)), the payout is covered by the score quote. Prints the payout
as hex and base58. Optional pins: the expected payout, compose hash and suite commitment."""
import re, sys, json
import verify_bundle

B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'


def base58(b):
    n, out = int.from_bytes(b, 'big'), ''
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    return '1' * (len(b) - len(b.lstrip(b'\0'))) + out


def check_payout(st):
    p = st.get('payout')
    assert p is not None, 'statement has no payout (a v1 statement without payout is never paid)'
    assert isinstance(p, str) and re.fullmatch(r'[0-9a-f]{64}', p), 'payout must be 64 lowercase hex chars'
    assert p != '0' * 64, 'payout is all zeros (the escrow refuses it)'
    return p


def verify(b, payout=None, compose_hash=None, suite_commitment=None, log=print):
    r = verify_bundle.verify(b, log=lambda *a: None)
    st = b['statement']
    assert r['version'] == 'v1' and st.get('v') == 'tessera-score-1', 'competition scores are tessera-score-1'
    p = check_payout(st)
    if payout is not None:
        assert p == payout, f'payout {p} != expected {payout}'
    ch = r['quotes'][0]['compose_hash']
    if compose_hash is not None:
        assert ch == compose_hash, f'enclave compose hash {ch} != expected {compose_hash}'
    if suite_commitment is not None:
        assert st['suite_commitment'] == suite_commitment, 'scored a different suite'
    log(f'score {st["correct"]}/{st["n"]} for {st["model_id"]}@{st["model_revision"][:10]} '
        f'weights {st["weights_sha256"][:16]}... on suite {st["suite_id"]} ({st["suite_commitment"][:16]}...)')
    log(f'payout {p} (base58 {base58(bytes.fromhex(p))})')
    log(f'enclave compose hash {ch}')
    log('bundle OK: both quotes verified, statement (with payout) bound by the score quote')
    return {'payout': p, 'compose_hash': ch, 'statement': st, 'quotes': r['quotes']}


if __name__ == '__main__':
    a = sys.argv[1:]
    opt = lambda k: a[a.index(k) + 1] if k in a else None
    vals = {opt(k) for k in ('--payout', '--compose-hash', '--suite-commitment')}
    path = [x for x in a if not x.startswith('--') and x not in vals][0]
    verify(json.load(open(path)), opt('--payout'), opt('--compose-hash'), opt('--suite-commitment'))
