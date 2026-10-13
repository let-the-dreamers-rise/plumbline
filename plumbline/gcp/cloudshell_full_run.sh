#!/usr/bin/env bash
# One real, attested Plumbline score on a Google Cloud Intel TDX VM, end to end, from Google Cloud Shell.
#
#   bash cloudshell_full_run.sh PROJECT_ID PAYOUT_ADDRESS     full run (about 30-45 min), deletes everything at the end
#   bash cloudshell_full_run.sh --cleanup-only PROJECT_ID     only delete what a run creates (plumbline-* names) and list
#
# What it does: clones the plumbline repo, checks the measured compose file, deploys a c3-standard-4 TDX VM
# with dstack-cloud v0.6.1 (self-hosted, key_provider tpm, no Phala KMS or gateway), opens port 8080 only to
# this Cloud Shell's own IP, checks the attestation (Intel PCK chain embedded, RTMR3 replay, compose hash),
# seals a fresh 30-item suite it never prints, enters Qwen2.5-0.5B-Instruct, verifies the bundle with the
# plumbline CLI and saves the results in ~/plumbline-run-1. A trap deletes the VM, images, bucket and
# firewall rule on ANY exit (success, failure or Ctrl+C) and then lists the project to show nothing is left.
#
# It never touches billing, quotas or the account type. Cost on the free-trial credit: about $0.23/h while
# the VM exists, so roughly $0.15-0.25 for one run.
#
# Optional: PLB_ZONE=us-central1-b bash cloudshell_full_run.sh ...   (if us-central1-a has no C3 capacity)
set -Eeuo pipefail

# ---------------------------------------------------------------- pins (do not edit) ----------------------
REPO_URL=https://github.com/let-the-dreamers-rise/plumbline.git
BRANCH=claude/plumbline-product
COMPOSE_FILE_SHA=eb4eba790a10fdd4b3371932135c404b292fa5046d836ad37bd97ed744e023b8   # docker-compose.compete.yml
EXPECT_COMPOSE=76834b601928147fd920cfeecd24a58bff53c633bb44b1199edc950c56514b19     # sha256(app-compose.json)
HELPER_SHA=aff8ffdc22ed30a44c21e90f333295189bb3b4fb14dd1a07a4918d546680e331                                                             # plumbline_gcp.py
DSTACK_VER=0.6.1
DSTACK_REL=https://github.com/Phala-Network/meta-dstack-cloud/releases/download/v$DSTACK_VER
DSTACK_CLI_URL=https://raw.githubusercontent.com/Phala-Network/meta-dstack-cloud/v$DSTACK_VER/scripts/bin/dstack-cloud
DSTACK_CLI_SHA=0ecbbfb7d9ace7732b7e93f244dd812aa376c0f775c2d5d6959f0fce6a4dc35b
MODEL_ID=Qwen/Qwen2.5-0.5B-Instruct                     # the board's pins (sealed-eval-board/models.json)
MODEL_REV=7ae557604adf67be50417f59c2c2f167def9a775
MODEL_FILE=model.safetensors
MODEL_SHA=fdf756fa7fcbe7404d5c60e26bff1a0c8b8aa1f72ced49e7dd0210fe288fb7fe
MODEL_SIZE=
SUITE_ITEMS=30
# names: everything this script creates in the cloud starts with plumbline-
APP_NAME=plumbline-gcp
INSTANCE=plumbline-tdx
BOOT_IMAGE=plumbline-dstack-cloud-0-6-1
DATA_IMAGE=plumbline-dstack-data-disk
FW_RULE=plumbline-tdx-allow-8080
FW_TAG=fw-plumbline-tdx
ZONE=${PLB_ZONE:-us-central1-a}
REGION=${ZONE%-*}

WORK=$HOME/plumbline-work
OUT=$HOME/plumbline-run-1
export CLOUDSDK_CORE_DISABLE_PROMPTS=1
export PATH=$HOME/.local/bin:$PATH

# ---------------------------------------------------------------- output helpers ---------------------------
T0=$(date +%s)
el() { local s=$(( $(date +%s) - T0 )); printf '%dm%02ds' $((s / 60)) $((s % 60)); }
log() { printf '[%s UTC | %s] %s\n' "$(date -u +%H:%M:%S)" "$(el)" "$*"; }
stage() { printf '\n'; log "== STAGE $1: $2   (estimate: $3)"; }
die() { log "STOPPED: $*"; exit 1; }
jget() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {}, {"d": d}))' "$@"; }

# plumbline_gcp.py, embedded byte for byte (sha256 checked after writing); it talks to the VM
write_helper() {
  cat > "$1" <<'PLUMBLINE_GCP_PY_EOF'
"""Helper for one Plumbline score on a GCP TDX VM running dstack-cloud. Python 3.9+, standard library only.

  python plumbline_gcp.py attest  http://IP:8080 [--out attest.json] [--expect-compose <hex>]
      GET /health and /attest with a fresh challenge. Checks the key-release binding, replays RTMR3
      (dstack-cloud sends runtime digests empty; they are recomputed, as the zk guest does), prints
      compose_hash and mr_td, and says whether the quote embeds the PCK chain (cert data 6 -> 5).
      Saves the response for `plumbline seal --attestation attest.json`. No Intel signature check here:
      `plumbline seal` and `plumbline verify` do that.
  python plumbline_gcp.py compose-hash shared/app-compose.json
  python plumbline_gcp.py enter http://IP:8080 --sealed sealed-suite.json --model ORG/NAME --revision <40 hex>
      --file model.safetensors --sha256 <64 hex> [--size N] --payout <base58 or 64 hex> [--dtype bfloat16]
      [--out bundle.json]
      POST /enter with no client timeout and TCP keepalive (scoring holds one HTTP request open for the
      whole run; Node's fetch in `plumbline enter` gives up after 300 s without response headers).
      Writes the bundle in the same shape as `plumbline enter`. Then run `plumbline verify bundle.json`.
Never reads or prints a suite file."""
import sys, json, hashlib, struct, secrets, socket, http.client, urllib.parse

RUNTIME = 0x08000001
B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'


def canonical(o):
    return json.dumps(o, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def b58decode(s):
    n = 0
    for c in s:
        n = n * 58 + B58.index(c)
    raw = n.to_bytes((n.bit_length() + 7) // 8, 'big')
    return b'\0' * (len(s) - len(s.lstrip('1'))) + raw


def payout_hex(p):
    if len(p) == 64 and all(c in '0123456789abcdef' for c in p):
        return p
    raw = b58decode(p)
    if len(raw) != 32:
        raise SystemExit('payout must be a Solana address (base58) or 64 lowercase hex chars')
    return raw.hex()


def parse_quote(q):
    ver, akt, tee = struct.unpack_from('<HHI', q, 0)
    body = q[48:632]
    info = {'version': ver, 'tee': hex(tee), 'mr_td': body[136:184].hex(), 'rtmr3': body[472:520].hex(),
            'report_data': body[520:584].hex(), 'pck_chain_embedded': False, 'certs': 0}
    try:
        sd = q[636:636 + struct.unpack_from('<I', q, 632)[0]]
        ct, cl = struct.unpack_from('<HI', sd, 128)
        cd = sd[134:134 + cl]
        al = struct.unpack_from('<H', cd, 448)[0]
        ct2, cl2 = struct.unpack_from('<HI', cd, 450 + al)
        info['cert_data_types'] = [ct, ct2]
        info['certs'] = cd[456 + al:456 + al + cl2].count(b'-----BEGIN CERTIFICATE-----')
        info['pck_chain_embedded'] = ct == 6 and ct2 == 5 and info['certs'] >= 3
    except struct.error:
        info['cert_data_types'] = 'unparseable'
    return info


def replay_rtmr3(event_log):
    events = json.loads(event_log) if isinstance(event_log, str) else event_log
    rtmr, compose, stripped = bytes(48), [], 0
    for e in events:
        if e.get('imr') != 3:
            continue
        payload = bytes.fromhex(e.get('event_payload') or '')
        d = bytes.fromhex(e.get('digest') or '')
        if e.get('event_type') == RUNTIME:
            calc = hashlib.sha384(struct.pack('<I', RUNTIME) + b':' + e.get('event', '').encode() + b':' + payload).digest()
            if not d:
                stripped, d = stripped + 1, calc
            elif d != calc:
                raise SystemExit(f'event {e.get("event")!r}: provided digest does not recompute')
        if len(d) != 48:
            raise SystemExit(f'RTMR3 event {e.get("event")!r} has no 48-byte digest')
        rtmr = hashlib.sha384(rtmr + d).digest()
        if e.get('event') == 'compose-hash':
            compose.append(payload.hex())
    return rtmr.hex(), compose, stripped


def request(url, method='GET', body=None, keepalive=False):
    u = urllib.parse.urlsplit(url)
    C = http.client.HTTPSConnection if u.scheme == 'https' else http.client.HTTPConnection
    c = C(u.hostname, u.port, timeout=None if keepalive else 120)
    c.connect()
    if keepalive:  # keep NAT / firewall connection tracking alive during a long, silent request
        c.sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        if hasattr(socket, 'SIO_KEEPALIVE_VALS'):
            c.sock.ioctl(socket.SIO_KEEPALIVE_VALS, (1, 60000, 10000))  # Windows: after 60 s idle, every 10 s
        elif hasattr(socket, 'TCP_KEEPIDLE'):
            c.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 60)
            c.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 10)
    path = (u.path or '/') + ('?' + u.query if u.query else '')
    c.request(method, path, body=body, headers={'Content-Type': 'application/json'} if body else {})
    r = c.getresponse()
    text = r.read().decode()
    if r.status != 200:
        raise SystemExit(f'HTTP {r.status} from {url}: {text[:300]}')
    return text


def opt(a, k, d=None):
    return a[a.index(k) + 1] if k in a else d


def attest(a):
    base = a[0].rstrip('/')
    h = json.loads(request(base + '/health'))
    print('health: ready', h.get('ready'), 'mode', h.get('mode'), 'limits_sha256', h.get('limits_sha256'))
    ch = secrets.token_hex(32)
    att = json.loads(request(f'{base}/attest?challenge={ch}'))
    pk = att['enclave_pubkey']
    q = parse_quote(bytes.fromhex(att['quote']))
    rd = hashlib.sha256(b'tessera:keyrelease:v1' + bytes.fromhex(pk) + bytes.fromhex(ch)).hexdigest()
    assert att['challenge'] == ch and att['report_data'] == rd and q['report_data'][:64] == rd, 'key-release binding FAILED'
    rtmr3, compose, stripped = replay_rtmr3(att.get('event_log') or '[]')
    print(f'quote: version {q["version"]}, tee {q["tee"]}, cert data {q["cert_data_types"]}, {q["certs"]} certs, '
          f'PCK chain embedded: {q["pck_chain_embedded"]}')
    print('mr_td', q['mr_td'])
    print(f'RTMR3 replay matches quote: {rtmr3 == q["rtmr3"]} ({stripped} stripped digests recomputed)')
    print('compose_hash', compose[0] if len(compose) == 1 and rtmr3 == q['rtmr3'] else f'NONE ({compose})')
    print('enclave_pubkey', pk)
    exp = opt(a, '--expect-compose')
    if exp and compose != [exp]:
        raise SystemExit(f'compose hash {compose} != expected {exp}: do NOT seal')
    out = opt(a, '--out', 'attest.json')
    json.dump(att, open(out, 'w'), indent=1)
    print('saved', out)


def enter(a):
    base = a[0].rstrip('/')
    s = json.load(open(opt(a, '--sealed')))
    if not s.get('challenge') or not s.get('key_release'):
        raise SystemExit('sealed-suite file has no challenge/key_release: seal with --attestation')
    w = {'file': opt(a, '--file', 'model.safetensors'), 'sha256': opt(a, '--sha256')}
    if opt(a, '--size'):
        w['size'] = int(opt(a, '--size'))
    pay = payout_hex(opt(a, '--payout'))
    req = {'challenge': s['challenge'], 'sealed': s['sealed'], 'model_id': opt(a, '--model'),
           'revision': opt(a, '--revision'), 'weights': [w], 'payout': pay, 'dtype': opt(a, '--dtype', 'bfloat16')}
    print('POST /enter (this can take 20-60 minutes; keep this window open)...', flush=True)
    resp = json.loads(request(base + '/enter', 'POST', json.dumps(req).encode(), keepalive=True))
    st = resp['statement']
    canon = canonical(st)
    rd = hashlib.sha256(b'tessera:score:v1' + canon).hexdigest()
    q = parse_quote(bytes.fromhex(resp['quote']))
    problems = []
    if resp['report_data'] != rd or q['report_data'][:64] != rd:
        problems.append('score quote does not bind the statement')
    if st.get('payout') != pay:
        problems.append('payout differs')
    if st.get('suite_commitment') != s['suite_commitment']:
        problems.append('different suite')
    if st.get('challenge') != s['challenge']:
        problems.append('different challenge')
    rtmr3, compose, _ = replay_rtmr3(resp['event_log'] or '[]')
    if rtmr3 != q['rtmr3']:
        problems.append('event log does not replay to RTMR3')
    rest = {'statement_sha256': hashlib.sha256(canon).hexdigest(), 'key_release': s['key_release'],
            'score': {'quote': resp['quote'], 'event_log': resp['event_log'], 'report_data': resp['report_data']},
            'challenge_source': {'source': 'sponsor-attest', 'challenge': s['challenge']}}
    out = opt(a, '--out', 'bundle.json')
    open(out, 'w', encoding='utf-8').write('{"statement": ' + canon.decode() + ',' + json.dumps(rest, indent=1)[1:])
    print(f'score {st["correct"]}/{st["n"]}, compose_hash {compose}, bundle saved to {out}')
    if problems:
        raise SystemExit('bundle FAILS: ' + '; '.join(problems))


def main():
    a = sys.argv[1:]
    if not a or a[0] not in ('attest', 'enter', 'compose-hash') or len(a) < 2:
        raise SystemExit(__doc__)
    if a[0] == 'compose-hash':
        print(hashlib.sha256(open(a[1], 'rb').read()).hexdigest())
    else:
        {'attest': attest, 'enter': enter}[a[0]](a[1:])


if __name__ == '__main__':
    main()
PLUMBLINE_GCP_PY_EOF
}

# ---------------------------------------------------------------- arguments -------------------------------
MODE=full TEST=0 URL= PROJECT= PAYOUT=
case "${1:-}" in
  --cleanup-only) MODE=cleanup; PROJECT=${2:-} ;;
  --enclave-url)  MODE=test; TEST=1; URL=${2:-}; PAYOUT=${3:-} ;;   # hidden: test against an existing enclave
  -h|--help|"") sed -n '2,6p' "$0"; exit 2 ;;
  *) PROJECT=$1; PAYOUT=${2:-} ;;
esac
if [ "$MODE" = test ]; then
  [ -n "$URL" ] && [ -n "$PAYOUT" ] || die "usage: --enclave-url URL PAYOUT_ADDRESS"
  # TEST ONLY overrides; ignored in a real run
  EXPECT_COMPOSE=${PLB_TEST_EXPECT_COMPOSE:-$EXPECT_COMPOSE}
  if [ -n "${PLB_TEST_MODEL_JSON:-}" ]; then
    MODEL_ID=$(jget "$PLB_TEST_MODEL_JSON" 'd["model_id"]'); MODEL_REV=$(jget "$PLB_TEST_MODEL_JSON" 'd["revision"]')
    MODEL_FILE=$(jget "$PLB_TEST_MODEL_JSON" 'd["file"]'); MODEL_SHA=$(jget "$PLB_TEST_MODEL_JSON" 'd["sha256"]')
    MODEL_SIZE=$(jget "$PLB_TEST_MODEL_JSON" 'd["size"]')
  fi
  SUITE_ITEMS=${PLB_TEST_SUITE_ITEMS:-$SUITE_ITEMS}
  WORK=${PLB_TEST_WORK:-$WORK}; OUT=${PLB_TEST_OUT:-$OUT}
else
  [[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "first argument must be your GCP project ID (got '${PROJECT}')"
fi
BUCKET=gs://plumbline-$PROJECT-dstack
PROJ=$WORK/$APP_NAME           # dstack-cloud project dir
RUN=$WORK/run                  # attest/sealed/bundle land here, then get copied to $OUT
SUITE_DIR=
FW_IP=
VM_IP=
CLEANED=0
CLOUD_TOUCHED=0               # set when the first cloud resource is about to be created
mkdir -p "$WORK"

# ---------------------------------------------------------------- cleanup ---------------------------------
shred_suite() {
  if [ -n "$SUITE_DIR" ] && [ -d "$SUITE_DIR" ]; then
    [ -f "$SUITE_DIR/suite.json" ] && shred -u -z "$SUITE_DIR/suite.json" 2>/dev/null
    rm -rf -- "${SUITE_DIR:?}"
  fi
}

cloud_cleanup() {
  local p=$PROJECT left=0 name zone
  set +e
  log "CLEANUP: deleting everything named plumbline-* in project $p (about 3-5 min; please wait, Ctrl+C is ignored now)"
  if [ -f "$PROJ/state.json" ] && command -v dstack-cloud >/dev/null; then
    (cd "$PROJ" && dstack-cloud remove) || log "dstack-cloud remove reported an error; deleting by name below"
  fi
  while read -r name zone; do
    [ -n "$name" ] || continue
    log "delete instance $name ($zone)"; gcloud compute instances delete "$name" --zone "${zone##*/}" --project "$p" --quiet
  done < <(gcloud compute instances list --project "$p" --filter="name~^plumbline-" --format="value(name,zone)" 2>/dev/null)
  while read -r name zone; do
    [ -n "$name" ] || continue
    log "delete disk $name"; gcloud compute disks delete "$name" --zone "${zone##*/}" --project "$p" --quiet
  done < <(gcloud compute disks list --project "$p" --filter="name~^plumbline-" --format="value(name,zone)" 2>/dev/null)
  for name in $(gcloud compute firewall-rules list --project "$p" --filter="name~^plumbline-" --format="value(name)" 2>/dev/null); do
    log "delete firewall rule $name"; gcloud compute firewall-rules delete "$name" --project "$p" --quiet
  done
  for name in $(gcloud compute images list --project "$p" --no-standard-images --filter="name~^plumbline-" --format="value(name)" 2>/dev/null); do
    log "delete image $name"; gcloud compute images delete "$name" --project "$p" --quiet
  done
  if gcloud storage buckets describe "$BUCKET" --project "$p" >/dev/null 2>&1; then
    log "delete bucket $BUCKET"; gcloud storage rm -r "$BUCKET" --project "$p" --quiet
  fi
  log "CLEANUP: listing what is left (should be nothing)"
  local what out
  for what in "instances" "disks" "images" "firewall-rules"; do
    if [ "$what" = images ]; then
      out=$(gcloud compute images list --project "$p" --no-standard-images --filter="name~^plumbline-" --format="value(name)" 2>&1)
    else
      out=$(gcloud compute "$what" list --project "$p" --filter="name~^plumbline-" --format="value(name)" 2>&1)
    fi
    if [ -n "$out" ]; then left=1; log "  $what: STILL THERE: $out"; else log "  $what: none"; fi
  done
  out=$(gcloud storage ls --project "$p" 2>&1 | grep -E "^gs://plumbline-" || true)
  if [ -n "$out" ]; then left=1; log "  buckets: STILL THERE: $out"; else log "  buckets: none"; fi
  out=$(gcloud compute instances list --project "$p" --format="value(name)" 2>/dev/null)
  [ -z "$out" ] || log "  note: other VMs exist in this project (not ours, not touched): $out"
  if [ $left = 0 ]; then
    log "CLEANUP VERIFIED: no plumbline-* VM, disk, image, firewall rule or bucket is left in $p. Nothing is billing."
  else
    log "CLEANUP INCOMPLETE. Run again:  bash $0 --cleanup-only $p"
    log "or delete the items above in the console (Compute Engine and Cloud Storage)."
  fi
  rm -f -- "${HOME:?}"/.dstack/images/*.tar.gz 2>/dev/null
  return $left
}

on_exit() {
  local rc=$?
  trap '' INT TERM HUP PIPE
  [ $CLEANED = 1 ] && return
  CLEANED=1
  set +e
  shred_suite
  if [ "$MODE" = full ]; then
    if [ $CLOUD_TOUCHED = 1 ]; then
      [ $rc = 0 ] || log "run did not finish (exit $rc); cleaning up anyway"
      cloud_cleanup
    else
      log "stopped before anything was created in the cloud; nothing to delete"
    fi
    [ -d "$OUT" ] && cp "$WORK/run.log" "$OUT/run.log" 2>/dev/null
  fi
  if [ $rc = 0 ] && [ "$MODE" != cleanup ]; then
    printf '\n'; log "DONE. Download the folder ~/plumbline-run-1 (Cloud Shell menu ⋮ -> Download, path: plumbline-run-1),"
    log "and attach bundle.json from it in the project thread."
  fi
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

if [ "$MODE" = cleanup ]; then
  [[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "usage: bash $0 --cleanup-only PROJECT_ID"
  BUCKET=gs://plumbline-$PROJECT-dstack
  log "cleanup-only mode for project $PROJECT"
  CLEANED=1; trap '' INT
  cloud_cleanup; exit $?
fi

# tee ignores Ctrl+C / hangup so the cleanup output is never cut off
[ "$MODE" = full ] && exec > >(trap '' INT TERM HUP; exec tee -a "$WORK/run.log") 2>&1
log "Plumbline Cloud Shell run: project ${PROJECT:-(test)}, zone $ZONE, payout $PAYOUT"
[ $TEST = 1 ] && log "TEST MODE against $URL: no deploy, no cleanup, Intel checks relaxed. NOT a real score."
log "whole run: about 30-45 min. Keep this tab open. If it closes, reopen Cloud Shell and run:"
log "  bash $0 --cleanup-only ${PROJECT:-PROJECT_ID}"

# payout must parse before anything is created
mkdir -p "$RUN"
write_helper "$RUN/plumbline_gcp.py"
echo "$HELPER_SHA  $RUN/plumbline_gcp.py" | sha256sum -c --quiet - || die "embedded plumbline_gcp.py is corrupted"
PAYOUT_HEX=$(cd "$RUN" && python3 -c 'import sys, plumbline_gcp as g; print(g.payout_hex(sys.argv[1]))' "$PAYOUT") \
  || die "payout '$PAYOUT' is not a Solana address"
log "payout ok ($PAYOUT_HEX)"

# ---------------------------------------------------------------- 1. repo ---------------------------------
stage 1 "clone the repo, check the measured compose file, npm ci" "2-3 min"
if [ $TEST = 1 ] && [ -n "${PLB_TEST_REPO_DIR:-}" ]; then
  REPO=$PLB_TEST_REPO_DIR; log "TEST: using existing checkout $REPO (no clone, no npm ci)"
else
  REPO=$WORK/repo
  rm -rf -- "${REPO:?}"
  SRC_TGZ=${PLB_SRC_TGZ:-$(dirname "$(readlink -f "$0")")/plumbline-src.tar.gz}
  if [ -f "$SRC_TGZ" ]; then
    # Uploaded source (works while the GitHub repo is private): git archive of the branch + its commit id.
    mkdir -p "$REPO" && tar -xzf "$SRC_TGZ" -C "$REPO" || die "could not unpack $SRC_TGZ"
    log "source from $SRC_TGZ"
  else
    git clone -q --depth 1 -b "$BRANCH" "$REPO_URL" "$REPO" \
      || die "git clone $REPO_URL ($BRANCH) failed. If the repo is private, upload plumbline-src.tar.gz next to this script and run again"
  fi
fi
log "repo at commit $(git -C "$REPO" rev-parse HEAD 2>/dev/null || cat "$REPO/COMMIT")"
COMPOSE_YML=$REPO/plumbline/enclave/docker-compose.compete.yml
echo "$COMPOSE_FILE_SHA  $COMPOSE_YML" | sha256sum -c --quiet - \
  || die "docker-compose.compete.yml differs from the pinned sha256 $COMPOSE_FILE_SHA (someone changed server.py or the limits)"
log "docker-compose.compete.yml sha256 ok ($COMPOSE_FILE_SHA)"
CLI=$REPO/plumbline/cli
if ! { [ $TEST = 1 ] && [ -n "${PLB_TEST_REPO_DIR:-}" ]; }; then
  node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' || die "node 18+ needed (have $(node --version))"
  (cd "$CLI" && npm ci --no-audit --no-fund --loglevel=error) || die "npm ci in plumbline/cli failed"
fi
plumbline() { (cd "$CLI" && npx tsx src/main.ts "$@"); }
log "plumbline CLI ready"

fw_sync() {   # keep the firewall rule at exactly this Cloud Shell's current egress IP
  [ $TEST = 1 ] && return 0
  local ip
  ip=$(curl -fsS -m 15 https://checkip.amazonaws.com | tr -d '[:space:]') || { log "could not read my IP (checkip)"; return 1; }
  [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { log "checkip returned '$ip'"; return 1; }
  if [ "$ip" != "$FW_IP" ]; then
    if gcloud compute firewall-rules describe "$FW_RULE" --project "$PROJECT" >/dev/null 2>&1; then
      log "Cloud Shell IP is now $ip (was ${FW_IP:-none}): updating $FW_RULE"
      gcloud compute firewall-rules update "$FW_RULE" --project "$PROJECT" --source-ranges "$ip/32" --quiet
    else
      log "creating $FW_RULE: tcp:8080 from $ip/32 only"
      gcloud compute firewall-rules create "$FW_RULE" --project "$PROJECT" --network default --direction INGRESS \
        --allow tcp:8080 --source-ranges "$ip/32" --target-tags "$FW_TAG" \
        --description "plumbline: enclave port, this Cloud Shell only" --quiet
    fi
    FW_IP=$ip
    sleep 5
  fi
}

if [ $TEST = 0 ]; then
  # -------------------------------------------------------------- 2. deploy -------------------------------
  stage 2a "tools, pinned dstack-cloud CLI, OS image, quota check" "3-4 min"
  free_mb=$(df -Pm "$HOME" | awk 'NR==2 {print $4}')
  [ "$free_mb" -ge 1500 ] || die "need 1.5 GB free in \$HOME, have ${free_mb} MB (delete old files and retry)"
  sudo apt-get install -y -qq mtools dosfstools gdisk >/dev/null 2>&1 \
    || { sudo apt-get update -qq >/dev/null 2>&1; sudo apt-get install -y -qq mtools dosfstools gdisk >/dev/null; } \
    || die "apt-get install mtools dosfstools gdisk failed"
  mkdir -p "$HOME/.local/bin" "$HOME/.config/dstack-cloud" "$HOME/.dstack/images"
  curl -fsSL -o "$HOME/.local/bin/dstack-cloud" "$DSTACK_CLI_URL" || die "could not download dstack-cloud"
  echo "$DSTACK_CLI_SHA  $HOME/.local/bin/dstack-cloud" | sha256sum -c --quiet - || die "dstack-cloud CLI sha256 mismatch"
  chmod +x "$HOME/.local/bin/dstack-cloud"
  log "dstack-cloud v$DSTACK_VER CLI sha256 ok"
  CFG=$HOME/.config/dstack-cloud/config.json
  [ -f "$CFG" ] && [ ! -f "$CFG.before-plumbline" ] && cp "$CFG" "$CFG.before-plumbline"
  cat > "$CFG" <<JSON
{"services": {"kms_urls": [], "gateway_urls": [], "pccs_url": ""},
 "image_search_paths": ["~/.dstack/images"],
 "gcp": {"project": "$PROJECT", "zone": "$ZONE", "bucket": "$BUCKET"}}
JSON
  gcloud config set project "$PROJECT" >/dev/null 2>&1
  gcloud services enable compute.googleapis.com storage.googleapis.com --project "$PROJECT" \
    || die "could not enable Compute Engine / Storage APIs (is the free trial active on $PROJECT?)"
  python3 - "$PROJECT" "$REGION" <<'EOF' || die "not enough C3 CPU quota in this region (try PLB_ZONE in another region; do NOT upgrade the account)"
import json, subprocess, sys
proj, region = sys.argv[1:]
q = json.loads(subprocess.run(['gcloud', 'compute', 'regions', 'describe', region, '--project', proj, '--format=json'],
                              check=True, capture_output=True, text=True).stdout)['quotas']
free = {x['metric']: x['limit'] - x['usage'] for x in q}
print('  quota free in', region, {k: free.get(k) for k in ('CPUS', 'C3_CPUS')})
sys.exit(0 if free.get('CPUS', 0) >= 4 and free.get('C3_CPUS', free.get('CPUS', 0)) >= 4 else 1)
EOF
  if [ ! -f "$HOME/.dstack/images/dstack-cloud-$DSTACK_VER/disk.raw" ]; then
    log "downloading dstack-cloud $DSTACK_VER OS images (2 x ~206 MB)"
    dstack-cloud pull "$DSTACK_REL/dstack-cloud-$DSTACK_VER.tar.gz"
    dstack-cloud pull "$DSTACK_REL/dstack-cloud-$DSTACK_VER-uki.tar.gz"
    rm -f -- "${HOME:?}"/.dstack/images/*.tar.gz
  fi
  [ -f "$HOME/.dstack/images/dstack-cloud-$DSTACK_VER/disk.raw" ] || die "disk.raw missing after pull (the VM would boot-loop)"
  # dstack-cloud reads auth_hash.txt from a folder named after the GCP boot image
  ln -sfn "dstack-cloud-$DSTACK_VER" "$HOME/.dstack/images/$BOOT_IMAGE"
  log "OS image ok"

  stage 2b "dstack project, predicted compose hash" "under 1 min"
  rm -rf -- "${PROJ:?}"
  (cd "$WORK" && dstack-cloud new "$APP_NAME" --os-image "dstack-cloud-$DSTACK_VER" --instance-name "$INSTANCE" \
    --key-provider tpm --no-gateway-enabled --project "$PROJECT" --zone "$ZONE" --machine-type c3-standard-4 --data-size 30) \
    > "$WORK/dstack-new.log" 2>&1 || { tail -5 "$WORK/dstack-new.log"; die "dstack-cloud new failed"; }
  python3 - "$PROJ/app.json" "$BOOT_IMAGE" "$DATA_IMAGE" "$BUCKET" "$INSTANCE" <<'EOF' || die "could not set plumbline-* names in app.json"
import json, sys
p, boot, data, bucket, inst = sys.argv[1:]
a = json.load(open(p)); g = a['gcp_config']
assert g['instance_name'] == inst and g['machine_type'] == 'c3-standard-4', g
assert a['key_provider'] == 'tpm' and a['gateway_enabled'] is False, a
g.update(boot_image=boot, data_image=data, bucket=bucket, labels={'owner': 'plumbline'})
json.dump(a, open(p, 'w'), indent=2)
EOF
  cp "$COMPOSE_YML" "$PROJ/docker-compose.yaml"
  (cd "$PROJ" && dstack-cloud prepare) > "$WORK/dstack-prepare.log" 2>&1 \
    || { tail -5 "$WORK/dstack-prepare.log"; die "dstack-cloud prepare failed"; }
  PRED=$(sha256sum "$PROJ/shared/app-compose.json" | cut -d' ' -f1)
  log "predicted compose_hash $PRED"
  [ "$PRED" = "$EXPECT_COMPOSE" ] || die "predicted compose hash differs from the expected $EXPECT_COMPOSE"
  log "compose hash matches the expected one"

  stage 2c "deploy the TDX VM (billing on the trial credit starts now)" "4-6 min"
  CLOUD_TOUCHED=1
  if ! gcloud storage buckets describe "$BUCKET" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud storage buckets create "$BUCKET" --project "$PROJECT" --location "$REGION" --uniform-bucket-level-access --quiet
  fi
  set +e
  (cd "$PROJ" && dstack-cloud deploy --delete) 2>&1 | tee "$WORK/deploy.log" \
    | grep --line-buffered -E "INFO - (Creating|Uploading|Instance|External|=== Deployment)|ERROR|Error"
  drc=${PIPESTATUS[0]}
  set -e
  [ "$drc" = 0 ] || die "dstack-cloud deploy failed (ZONE_RESOURCE_POOL_EXHAUSTED? retry with PLB_ZONE=us-central1-b)"
  VM_IP=$(gcloud compute instances describe "$INSTANCE" --zone "$ZONE" --project "$PROJECT" \
    --format="value(networkInterfaces[0].accessConfigs[0].natIP)")
  CT=$(gcloud compute instances describe "$INSTANCE" --zone "$ZONE" --project "$PROJECT" \
    --format="value(confidentialInstanceConfig.confidentialInstanceType)")
  [ -n "$VM_IP" ] || die "VM has no external IP"
  [ "$CT" = TDX ] || die "VM is not a TDX confidential VM (got '$CT')"
  POST=$(sha256sum "$PROJ/shared/app-compose.json" | cut -d' ' -f1)
  [ "$POST" = "$EXPECT_COMPOSE" ] || die "deploy regenerated app-compose.json with hash $POST"
  log "VM $INSTANCE up: TDX, external IP $VM_IP, compose hash still $POST"
  fw_sync || die "could not set the firewall rule"
  URL=http://$VM_IP:8080
fi

# ---------------------------------------------------------------- 4. health --------------------------------
stage 4 "wait for the enclave: boot + pip install torch + /health ready" "5-12 min"
H=$RUN/health.json
deadline=$(( $(date +%s) + 35 * 60 )); next_note=0; timeouts=0
while :; do
  rc=0; curl -fsS -m 10 -o "$H" "$URL/health" 2>/dev/null || rc=$?
  if [ $rc = 0 ]; then
    if [ "$(jget "$H" 'd.get("error") is not None')" = True ]; then
      die "enclave boot error: $(jget "$H" 'str(d["error"])[-400:]')"
    fi
    [ "$(jget "$H" 'd.get("ready") is True and d.get("mode") == "competition"')" = True ] && break
  elif [ $rc = 28 ]; then
    timeouts=$((timeouts + 1)); if [ $((timeouts % 3)) = 0 ]; then fw_sync || true; fi
  fi
  now=$(date +%s)
  [ "$now" -lt "$deadline" ] || die "enclave not ready after 35 min"
  if [ "$now" -ge "$next_note" ]; then
    next_note=$((now + 120))
    msg="not reachable yet (curl exit $rc)"; [ $rc = 0 ] && msg="answering, not ready yet"
    if [ $TEST = 0 ]; then
      serial=$(gcloud compute instances get-serial-port-output "$INSTANCE" --zone "$ZONE" --project "$PROJECT" 2>/dev/null || true)
      grep -q "Failed to load image" <<<"$serial" && die "VM boot-loops: Failed to load image"
      last=$(grep -E "tessera|Successfully installed|Collecting|competition enclave" <<<"$serial" | tail -1 | cut -c1-110 || true)
      [ -n "$last" ] && msg="$msg; serial: $last"
    fi
    log "waiting: $msg"
  fi
  sleep 10
done
log "enclave ready: mode $(jget "$H" 'd["mode"]'), limits sha256 $(jget "$H" 'd["limits_sha256"]')"

# ---------------------------------------------------------------- 4-6. attest, seal, enter -----------------
attest_seal_enter() {
  stage 4b "attest with --expect-compose (fresh challenge)" "under 1 min"
  fw_sync || true
  local a
  a=$(cd "$RUN" && python3 plumbline_gcp.py attest "$URL" --expect-compose "$EXPECT_COMPOSE" --out "$RUN/attest.json" 2>&1) \
    || { echo "$a" | tail -5; die "attestation check failed: do NOT seal"; }
  echo "$a" | sed 's/^/    /'
  grep -q "PCK chain embedded: True" <<<"$a" || die "quote does not embed the Intel PCK chain"
  grep -q "RTMR3 replay matches quote: True" <<<"$a" || die "RTMR3 event log does not replay to the quote"
  grep -q "^compose_hash $EXPECT_COMPOSE\$" <<<"$a" || die "attested compose hash is not $EXPECT_COMPOSE"
  grep -q "^health: ready True mode competition" <<<"$a" || die "enclave not ready in competition mode"
  EPK=$(jget "$RUN/attest.json" 'd["enclave_pubkey"]')
  [[ "$EPK" =~ ^[0-9a-f]{64}$ ]] || die "bad enclave_pubkey"
  log "attestation ok: Intel PCK chain embedded, RTMR3 replays, compose hash $EXPECT_COMPOSE, enclave key $EPK"

  stage 5 "generate a fresh $SUITE_ITEMS-item suite (never printed), seal it, shred the plaintext" "under 1 min"
  shred_suite
  SUITE_DIR=$(mktemp -d); chmod 700 "$SUITE_DIR"
  (cd "$SUITE_DIR" && umask 077 && python3 "$REPO/plumbline/enclave/gen_suite.py" "$SUITE_ITEMS" >/dev/null) || die "gen_suite.py failed"
  local sealflags=() s
  [ $TEST = 1 ] && sealflags=(--skip-intel-check)
  s=$(plumbline seal "$SUITE_DIR/suite.json" --enclave-pubkey "$EPK" --attestation "$RUN/attest.json" \
      -o "$RUN/sealed-suite.json" "${sealflags[@]}" 2>&1) || { shred_suite; echo "$s" | tail -3; die "seal failed"; }
  shred_suite
  log "plaintext suite shredded"
  echo "$s" | sed 's/^/    /'
  if [ $TEST = 0 ]; then
    grep -q "quote check: intel" <<<"$s" || die "seal did not verify the quote to Intel's root"
  fi
  python3 - "$RUN/sealed-suite.json" "$RUN/attest.json" <<'EOF' || die "sealed-suite does not match the attestation"
import json, sys
s, a = (json.load(open(p)) for p in sys.argv[1:])
assert s['challenge'] == a['challenge'] and s['enclave_pubkey'] == a['enclave_pubkey'] and s['key_release']
EOF
  log "sealed: commitment $(jget "$RUN/sealed-suite.json" 'd["suite_commitment"]')"

  stage 6 "enter $MODEL_ID and score it inside the enclave" "10-20 min"
  local args=(enter "$URL" --sealed "$RUN/sealed-suite.json" --model "$MODEL_ID" --revision "$MODEL_REV"
              --file "$MODEL_FILE" --sha256 "$MODEL_SHA" --payout "$PAYOUT" --out "$RUN/bundle.json")
  [ -n "$MODEL_SIZE" ] && args+=(--size "$MODEL_SIZE")
  fw_sync || true
  rm -f -- "${RUN:?}/bundle.json"
  local rc=0
  (cd "$RUN" && timeout 100m python3 plumbline_gcp.py "${args[@]}") 2>&1 | tee "$RUN/enter.log" || rc=${PIPESTATUS[0]}
  ENTER_RC=$rc
}

ATTEMPT=1
while :; do
  attest_seal_enter
  [ "$ENTER_RC" = 0 ] && break
  if [ "$ENTER_RC" = 124 ]; then die "/enter took over 100 min"; fi
  if grep -qE "bundle FAILS|HTTP [0-9]{3} from" "$RUN/enter.log" || [ -f "$RUN/bundle.json" ]; then
    die "/enter failed a check or was refused by the enclave (see above)"
  fi
  if [ $ATTEMPT -ge 2 ] || ! grep -qE "ConnectionResetError|RemoteDisconnected|BrokenPipeError|TimeoutError|ConnectionAbortedError|IncompleteRead" "$RUN/enter.log"; then
    die "/enter failed (exit $ENTER_RC)"
  fi
  ATTEMPT=$((ATTEMPT + 1))
  log "connection dropped during /enter; waiting for the enclave to be idle, then retrying ONCE with a new suite"
  fw_sync || true
  for _ in $(seq 120); do
    curl -fsS -m 10 -o "$H" "$URL/health" 2>/dev/null && [ "$(jget "$H" 'd.get("busy") is False and d.get("ready") is True')" = True ] && break
    sleep 30
  done
done

# ---------------------------------------------------------------- 6b. verify --------------------------------
stage 6b "plumbline verify the bundle" "under 1 min"
python3 - "$RUN" "$RUN/bundle.json" "$EXPECT_COMPOSE" "$PAYOUT_HEX" "$SUITE_ITEMS" "$MODEL_ID" "$MODEL_REV" <<'EOF' || die "bundle check failed"
import json, sys
sys.path.insert(0, sys.argv[1]); import plumbline_gcp as g
_, path, compose, payout, n, model, rev = sys.argv[1:]
b = json.load(open(path)); st = b['statement']
_, events, _ = g.replay_rtmr3(b['score']['event_log'] or '[]')
checks = {'compose hash in the score quote\'s event log': events == [compose], 'payout': st['payout'] == payout,
          f'n = {n}': st['n'] == int(n), 'model': st['model_id'] == model and st['model_revision'] == rev}
for k, v in checks.items(): print(('    ok   ' if v else '    FAIL ') + k)
sys.exit(0 if all(checks.values()) else 1)
EOF
vflags=(--cluster devnet); [ $TEST = 1 ] && vflags=(--quote-check binding)
v=$(plumbline verify "$RUN/bundle.json" "${vflags[@]}" 2>&1) || { echo "$v"; die "plumbline verify failed"; }
echo "$v" | sed 's/^/    /'
grep -q "FAIL" <<<"$v" && die "plumbline verify printed a FAIL line"
log "bundle verified"

# ---------------------------------------------------------------- 7. save -----------------------------------
stage 7 "save results to ~/plumbline-run-1" "seconds"
[ -d "$OUT" ] && mv "$OUT" "$OUT.old-$(date -u +%Y%m%dT%H%M%S)"
mkdir -p "$OUT"
cp "$RUN/bundle.json" "$RUN/attest.json" "$RUN/sealed-suite.json" "$OUT/"
if [ $TEST = 0 ]; then
  cp "$PROJ/shared/app-compose.json" "$OUT/app-compose.json"
  sha256sum "$PROJ/shared/app-compose.json" | cut -d' ' -f1 > "$OUT/compose_hash.txt"
else
  echo "$EXPECT_COMPOSE" > "$OUT/compose_hash.txt"
fi
python3 - "$RUN" "$OUT/bundle.json" "$OUT/attest.json" > "$OUT/summary.txt" <<EOF
import json, sys, hashlib
sys.path.insert(0, sys.argv[1]); import plumbline_gcp as g
b = json.load(open(sys.argv[2])); a = json.load(open(sys.argv[3])); st = b['statement']
q = g.parse_quote(bytes.fromhex(b['score']['quote']))
print('Plumbline attested score, GCP Intel TDX (dstack-cloud $DSTACK_VER, $ZONE)$([ $TEST = 1 ] && echo ' -- TEST MODE, NOT REAL')')
print('date (UTC)       ', '$(date -u +%Y-%m-%dT%H:%M:%SZ)')
print('repo commit      ', '$(git -C "$REPO" rev-parse HEAD)')
print('score            ', f"{st['correct']}/{st['n']}")
print('model            ', st['model_id'], st['model_revision'], 'weights', st['weights_sha256'])
print('suite commitment ', st['suite_commitment'])
print('payout (hex)     ', st['payout'])
print('statement sha256 ', b['statement_sha256'])
print('compose hash     ', '$EXPECT_COMPOSE')
print('mr_td            ', q['mr_td'])
print('rtmr3            ', q['rtmr3'])
print('enclave key      ', a['enclave_pubkey'])
EOF
sed 's/^/    /' "$OUT/summary.txt"
log "saved: $(cd "$OUT" && ls | tr '\n' ' ')"
log "RESULT: ~/plumbline-run-1 is ready. Download it (Cloud Shell ⋮ -> Download -> plumbline-run-1) and attach bundle.json in the project thread."
[ "$MODE" = full ] && log "now deleting the VM and everything else (cleanup runs automatically)"
exit 0
