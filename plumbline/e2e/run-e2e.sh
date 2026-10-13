#!/usr/bin/env bash
# Plumbline end to end on a local chain, from scratch (see README.md for what is real and what is faked):
#   test root + e2e prover build -> solana-test-validator + upgradeable deploys + registry config ->
#   competition enclave (real server.py, stub dstack/HTTPS/model) -> sponsor: seal, suite register,
#   bounty create -> entrant: enter with a fresh payout key -> relayer --once (real Groth16, ~20 min) ->
#   onchain checks -> web app screenshots.
# Localnet only. Every key is fresh and lives in a temp work dir that is deleted at the end
# (KEEP_WORK=1 keeps it, minus the ledger).
#   RPC_PORT (8999)  ENCLAVE_PORT (18080)  APP_PORT (18081)  REWARD (0.5 SOL)  TARGET (4/6)  SUITE_ITEMS (6)
#   E2E_ZK_TARGET    cargo target dir for the prover build (default ~/.cache/plumbline-e2e/zk-target)
#   E2E_TMP          parent of the work dir (default /tmp; not /dev/shm)
set -euo pipefail
E2E=$(cd "$(dirname "$0")" && pwd)
PL=$(cd "$E2E/.." && pwd)
export PATH=/opt/solana-2.1.21/solana-release/bin:$PATH
RPC_PORT=${RPC_PORT:-8999}; ENCLAVE_PORT=${ENCLAVE_PORT:-18080}; APP_PORT=${APP_PORT:-18081}
REWARD=${REWARD:-0.5}; TARGET=${TARGET:-4/6}; SUITE_ITEMS=${SUITE_ITEMS:-6}
RPC=http://127.0.0.1:$RPC_PORT
ENCLAVE=http://127.0.0.1:$ENCLAVE_PORT
TSX=$PL/cli/node_modules/.bin/tsx
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost

WORK=$(mktemp -d "${E2E_TMP:-/tmp}/plumbline-e2e.XXXXXX")
PIDS=()
T0=$(date +%s)
step() { printf '\n== [%4ss] %s\n' $(( $(date +%s) - T0 )) "$*"; }
die() { echo "E2E FAIL: $*"; exit 1; }
cleanup() {
  local rc=$?
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  for p in "${PIDS[@]}"; do wait "$p" 2>/dev/null || true; done
  rm -rf "$WORK/ledger" "$WORK/prover/zk" "$WORK/control"
  if [ "${KEEP_WORK:-}" = 1 ]; then echo "work dir kept: $WORK"; else rm -rf "$WORK"; fi
  if [ $rc != 0 ]; then echo "E2E exited $rc"; elif [ -n "${STOPPED:-}" ]; then echo "E2E stopped early (no verdict)"; else echo "E2E PASS"; fi
}
trap cleanup EXIT
free_port() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
wait_http() { for _ in $(seq "${2:-60}"); do curl -sf -o /dev/null "$1" && return 0; sleep 1; done; return 1; }
json() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {}, {"d": d}))' "$@"; }
pl() { "$PL/cli/bin/plumbline" --cluster "$RPC" "$@"; }

step "preflight"
for p in "$RPC_PORT" $((RPC_PORT + 1010)) "$ENCLAVE_PORT" "$APP_PORT"; do free_port "$p" || die "port $p is in use"; done
docker info >/dev/null 2>&1 || die "docker daemon not running (nohup dockerd > /tmp/dockerd.log 2>&1 &)"
for d in cli relayer app; do [ -d "$PL/$d/node_modules" ] || die "run npm install in plumbline/$d"; done
echo "work dir $WORK; free disk $(df -h --output=avail "$WORK" | tail -1 | tr -d ' ')"
echo "solana $(solana --version | cut -d' ' -f2), node $(node --version), git $(git -C "$PL" rev-parse --short HEAD) on $(git -C "$PL" branch --show-current)"

# ---------------------------------------------------------------------------------------------------
step "1a. TEST ONLY root + prover: fresh PCK chain, test-root guest re-pinned to it"
mkdir -p "$WORK/prover" "$WORK/control"
python3 "$E2E/mint_test_root.py" "$WORK/prover"
ROOT_SHA=$(sha256sum "$WORK/prover/test-root.der" | cut -d' ' -f1)
# control: the same copy with the repo's own root must reproduce the repo's test-root image id
cp "$PL/zk/fixtures/test-root.der" "$WORK/control/"
bash "$E2E/build-prover.sh" "$WORK/control"
REPO_ID=$(cat "$WORK/control/image-id.txt")
bash "$E2E/build-prover.sh" "$WORK/prover"
IMAGE_ID=$(cat "$WORK/prover/image-id.txt")
HOST_BIN=$WORK/prover/tessera-risc0-host
echo "control build, repo test root:  image id $REPO_ID"
echo "e2e build, e2e test root:      image id $IMAGE_ID, root sha256 $ROOT_SHA"
[ "$REPO_ID" = 0x7aaa8f274bbbc3501ecee9552592a47e35a3345bd2dc3b8314a7f500187699a7 ] || die "control image id differs from zk/README.md"
[ "$IMAGE_ID" != "$REPO_ID" ] || die "e2e image id should differ (different root)"
rm -rf "$WORK/control" "$WORK/prover/zk"

# ---------------------------------------------------------------------------------------------------
step "1b. solana-test-validator on $RPC + upgradeable deploys"
for k in operator sponsor relayer payout; do solana-keygen new --no-bip39-passphrase -s -o "$WORK/$k.json" >/dev/null; done
pk() { solana-keygen pubkey "$WORK/$1.json"; }
OPERATOR=$(pk operator); SPONSOR=$(pk sponsor); RELAYER=$(pk relayer); PAYOUT=$(pk payout)
echo "operator $OPERATOR (deploys, registry admin)"
echo "sponsor  $SPONSOR"
echo "relayer  $RELAYER (fee payer only)"
echo "payout   $PAYOUT (entrant's fresh payout key, never funded)"
solana-test-validator -r -q --ledger "$WORK/ledger" --rpc-port "$RPC_PORT" --faucet-port $((RPC_PORT + 1010)) \
  --gossip-port $((RPC_PORT + 1020)) --dynamic-port-range $((RPC_PORT + 1030))-$((RPC_PORT + 1130)) > "$WORK/validator.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 90); do solana -u "$RPC" cluster-version >/dev/null 2>&1 && break; sleep 1; done
echo "validator up: genesis $(solana -u "$RPC" genesis-hash)"
solana -u "$RPC" airdrop 50 "$OPERATOR" >/dev/null; solana -u "$RPC" airdrop 20 "$SPONSOR" >/dev/null
solana -u "$RPC" airdrop 5 "$RELAYER" >/dev/null
for p in registry bounty; do
  echo "deploy plumbline_$p: $(solana -u "$RPC" -k "$WORK/operator.json" program deploy --program-id \
    "$PL/programs/target/deploy/plumbline_${p}-keypair.json" "$PL/programs/target/deploy/plumbline_${p}.so" | tr '\n' ' ')"
done

# ---------------------------------------------------------------------------------------------------
step "2. competition enclave (real server.py; stub dstack signs with the e2e test root)"
python3 "$E2E/enclave_host.py" --port "$ENCLAVE_PORT" --pki "$WORK/prover" --work "$WORK/enclave" \
  --model-json "$WORK/model.json" > "$WORK/enclave.log" 2>&1 &
PIDS+=($!)
mkdir -p "$WORK/enclave"
wait_http "$ENCLAVE/health" 30 || { cat "$WORK/enclave.log"; die "enclave did not come up"; }
head -1 "$WORK/enclave.log"
curl -sf "$ENCLAVE/health" > "$WORK/health.json"
EPK=$(json "$WORK/health.json" 'd["enclave_pubkey"]')
COMPOSE=$(json "$WORK/model.json" 'd["compose_hash"]')
echo "enclave key $EPK, ready $(json "$WORK/health.json" 'd["ready"]'), mode $(json "$WORK/health.json" 'd["mode"]')"
echo "compose hash (stub dstack event) $COMPOSE"

step "1c. registry config: e2e test-root image id + root, enclave compose hash"
"$TSX" "$E2E/chain_tool.ts" init-config "$RPC" "$WORK/operator.json" "$IMAGE_ID" "$ROOT_SHA" "$COMPOSE" | tee "$WORK/config.json"

# ---------------------------------------------------------------------------------------------------
step "3a. sponsor: throwaway suite ($SUITE_ITEMS items, generated in the work dir, never printed)"
mkdir -p "$WORK/sponsor" && (cd "$WORK/sponsor" && python3 "$PL/enclave/gen_suite.py" "$SUITE_ITEMS")
step "3b. sponsor: plumbline seal (fetches /attest with a fresh challenge; binding checked, test-root quote)"
(cd "$WORK/sponsor" && pl seal suite.json --enclave-pubkey "$EPK" --enclave "$ENCLAVE" --skip-intel-check -o sealed.json)
step "3c. sponsor: plumbline suite register"
pl --keypair "$WORK/sponsor.json" suite register "$WORK/sponsor/sealed.json"
step "3d. sponsor: plumbline bounty create ($REWARD SOL for $TARGET, pinned to this compose + guest image)"
pl --keypair "$WORK/sponsor.json" --json bounty create --suite "$WORK/sponsor/sealed.json" --reward "$REWARD" --target "$TARGET" \
  --require-registered-suite --pin-compose "$COMPOSE" --pin-image "${IMAGE_ID#0x}" > "$WORK/bounty.json"
BOUNTY=$(json "$WORK/bounty.json" 'd["bounty"]')
echo "bounty $BOUNTY, tx $(json "$WORK/bounty.json" 'd["signature"]')"
pl bounty show "$BOUNTY"

# ---------------------------------------------------------------------------------------------------
step "3e. entrant: plumbline enter with the fresh payout key"
M=$WORK/model.json
mkdir -p "$WORK/entrant"
pl enter --enclave "$ENCLAVE" --sealed "$WORK/sponsor/sealed.json" --model "$(json "$M" 'd["model_id"]')" \
  --revision "$(json "$M" 'd["revision"]')" --payout "$PAYOUT" \
  --shard "model.safetensors=$(json "$M" 'd["sha256"]'):$(json "$M" 'd["size"]')" -o "$WORK/entrant/bundle.json"
python3 - "$WORK/entrant/bundle.json" <<'EOF'
import json, sys
b = json.load(open(sys.argv[1]))
s = b['statement']
print('statement', b['statement_sha256'])
for k in ('v', 'suite_commitment', 'n', 'correct', 'model_id', 'model_revision', 'weights_sha256', 'payout'):
    print(f'  {k}: {s[k]}')
EOF
"$PL/cli/bin/plumbline" verify "$WORK/entrant/bundle.json" --quote-check binding
STATEMENT=$(json "$WORK/entrant/bundle.json" 'd["statement_sha256"]')

step "4a. guest execute on the bundle (seconds; the same guest the relayer proves with)"
python3 "$PL/zk/scripts/bundle_to_inputs.py" "$WORK/entrant/bundle.json" "$WORK/inputs"
IMAGE=testroot "$HOST_BIN" execute "$WORK/inputs/quote.bin" "$WORK/inputs/statement.json" "$WORK/inputs/event_log.json" \
  | tee "$WORK/execute.txt" | grep -v '^journal'
python3 - "$WORK/execute.txt" "$STATEMENT" "$ROOT_SHA" "$COMPOSE" "$PAYOUT" <<'EOF2'
import sys
B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
txt, stmt, root, compose, payout = sys.argv[1:]
j = bytes.fromhex(open(txt).read().split('journal: 0x')[1].split()[0])
n = int.from_bytes(j[298:330], 'big'); s = ''
while n: n, r = divmod(n, 58); s = B58[r] + s
s = '1' * (len(j[298:330]) - len(j[298:330].lstrip(b'\0'))) + s
c = {'journal is 330 bytes': len(j) == 330, 'statement_hash': j[0:32].hex() == stmt, 'root_sha256 = e2e root': j[224:256].hex() == root,
     'bound = 1': j[265] == 1, 'compose_hash = enclave event (RTMR3 replayed)': j[266:298].hex() == compose, 'payout = entrant key': s == payout}
print(f"journal: correct {int.from_bytes(j[256:260], 'little')}/{int.from_bytes(j[260:264], 'little')}, payout {s}")
for k, v in c.items(): print(('  ok  ' if v else '  FAIL ') + k)
sys.exit(0 if all(c.values()) else 1)
EOF2
[ "${STOP_AFTER:-}" = execute ] && { STOPPED=1; echo "STOP_AFTER=execute: not proving"; exit 0; }

# ---------------------------------------------------------------------------------------------------
step "4. relayer --once: Groth16 proof (real prover, e2e test-root guest) -> record_verified_score -> claim"
"$TSX" "$E2E/chain_tool.ts" balances "$RPC" "$PAYOUT" "$RELAYER" "$SPONSOR" | tee "$WORK/before.json"
mkdir -p "$WORK/relayer/inbox"
cp "$WORK/entrant/bundle.json" "$WORK/relayer/inbox/bundle.json"
cat > "$WORK/relayer/relayer.json" <<EOF
{"cluster": "$RPC", "keypair": "$WORK/relayer.json", "inbox": "$WORK/relayer/inbox",
 "stateFile": "$WORK/relayer/state.json", "workDir": "$WORK/relayer/work", "logFile": "$WORK/relayer/relayer.log",
 "prover": {"command": ["$HOST_BIN", "groth16", "{quote}", "{statement}", "{event_log}"],
            "env": {"OUT": "{out}", "IMAGE": "testroot"}, "cwd": "$WORK/relayer", "timeoutMs": 7200000}}
EOF
(cd "$PL/relayer" && "$PL/relayer/node_modules/.bin/tsx" src/main.ts --config "$WORK/relayer/relayer.json" --once)
python3 - "$WORK/relayer/state.json" "$STATEMENT" <<'EOF'
import json, sys
e = json.load(open(sys.argv[1]))
e = e.get('entries', e).get(sys.argv[2]) if isinstance(e, dict) else None
print('relayer state:', json.dumps(e, indent=1) if e else 'missing')
sys.exit(0 if e and e.get('status') == 'claimed' else 1)
EOF

# ---------------------------------------------------------------------------------------------------
step "5. onchain checks"
"$TSX" "$E2E/chain_tool.ts" check "$RPC" "$BOUNTY" "$WORK/entrant/bundle.json" "$PAYOUT" "$RELAYER" "$WORK/before.json"
pl bounty show "$BOUNTY"
echo "payout balance (solana CLI): $(solana -u "$RPC" balance "$PAYOUT")"

# ---------------------------------------------------------------------------------------------------
step "6. web app screenshots (headless Chromium, app pointed at $RPC)"
node "$PL/app/test/serve.mjs" "$APP_PORT" > "$WORK/app.log" 2>&1 &
PIDS+=($!)
wait_http "http://127.0.0.1:$APP_PORT/" 20 || die "app server did not start"
node "$E2E/screenshots.mjs" "http://127.0.0.1:$APP_PORT" "$RPC" "$BOUNTY" "$PAYOUT" "$E2E"
step "done in $(( ($(date +%s) - T0) / 60 )) min"
