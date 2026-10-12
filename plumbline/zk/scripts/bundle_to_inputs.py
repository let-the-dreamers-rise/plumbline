"""python3 scripts/bundle_to_inputs.py bundle-<suite>.json <outdir>

Splits an Ironproof sealed-eval bundle into the three guest inputs:
  <outdir>/quote.bin       bytes.fromhex(bundle.score.quote)
  <outdir>/statement.json  canonical(bundle.statement), exactly as the enclave hashed it
  <outdir>/event_log.json  bundle.score.event_log verbatim (dstack GetQuote JSON string)
and checks what can be checked offline before spending ~18 minutes proving:
  sha256(statement.json) == bundle.statement_sha256
  quote report_data[0:32] == sha256(b"tessera:score:v1" || statement.json)  (the guest's `bound`)
  the event log has a runtime compose-hash event, and every RTMR3 runtime event's digest is either
  empty (dstack-cloud strips it) or equals sha384(type_le32 || ":" || name || ":" || payload)
"""
import hashlib, json, os, sys

RUNTIME_EVENT_TYPE = 0x08000001


def canonical(obj):  # identical to sealed-eval/tessera_eval.py
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def main(bundle_path, out):
    b = json.load(open(bundle_path))
    os.makedirs(out, exist_ok=True)
    st = canonical(b['statement'])
    quote = bytes.fromhex(b['score']['quote'])
    log = b['score'].get('event_log') or '[]'
    if not isinstance(log, str):
        log = json.dumps(log)
    open(f'{out}/statement.json', 'wb').write(st)
    open(f'{out}/quote.bin', 'wb').write(quote)
    open(f'{out}/event_log.json', 'w').write(log)

    ok = True
    sh = hashlib.sha256(st).hexdigest()
    print('statement_sha256', sh, 'OK' if sh == b.get('statement_sha256') else 'MISMATCH')
    ok &= sh == b.get('statement_sha256')
    # TDX v4 quote: 48-byte header, TD report body; report_data at body offset 520 (64 bytes)
    rd = quote[48 + 520:48 + 520 + 64]
    want = hashlib.sha256(b'tessera:score:v1' + st).digest()
    print('report_data binds statement', 'OK' if rd[:32] == want else 'NO (journal will say bound=0)')
    ok &= rd[:32] == want
    events = [e for e in json.loads(log) if e.get('imr') == 3]
    bad, compose = [], []
    for e in events:
        if e.get('event_type') != RUNTIME_EVENT_TYPE:
            if len(bytes.fromhex(e.get('digest') or '')) != 48:
                bad.append(e.get('event'))
            continue
        p = bytes.fromhex(e.get('event_payload') or '')
        d = hashlib.sha384(RUNTIME_EVENT_TYPE.to_bytes(4, 'little') + b':' + e['event'].encode() + b':' + p).hexdigest()
        if e.get('digest') and e['digest'] != d:
            bad.append(e['event'])
        if e['event'] == 'compose-hash':
            compose.append(p.hex())
    stripped = sum(1 for e in events if not e.get('digest'))
    print('rtmr3 events', len(events), 'with stripped digest', stripped, 'compose-hash', compose)
    if bad:
        print('RTMR3 events whose digest does not recompute (guest rejects the log):', bad)
        ok = False
    if len(compose) != 1 or len(bytes.fromhex(compose[0])) != 32:
        print('need exactly one 32-byte runtime compose-hash event, else compose_hash is zero / log rejected')
        ok = False
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
