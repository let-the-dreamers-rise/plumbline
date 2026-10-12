# Plumbline: how it works for sponsors and entrants

Plumbline runs model competitions on private test data, and the prize pays itself out. A sponsor locks a
reward against a test set nobody else can read. Anyone can enter a model. A TDX enclave scores the model
on the test set, and nobody sees the questions, us included. A zero-knowledge proof then checks the
enclave's Intel quote on Solana. Once a verified score meets the target, the escrow pays the entrant's
own wallet.

v0 runs on **localnet** (the default) and **devnet** (`--cluster devnet`). The CLI, relayer and web app
refuse mainnet by name, by URL and by genesis hash.

## The sponsor, step by step

1. **Write the test set** as a JSON suite file and keep it on your machine. Only its commitment goes on
   chain: `sha256` of its canonical JSON, computed byte for byte as the enclave computes it.
2. **Seal it to the competition enclave.**
   ```
   plumbline seal my-suite.json --enclave https://<enclave> --enclave-pubkey <hex> -o sealed-suite.json
   ```
   - The CLI picks a fresh random challenge and calls the enclave's `GET /attest`.
   - It checks that the Intel TDX quote verifies to Intel's root, and that its report data binds the
     enclave key you named to that challenge.
   - Only then does it encrypt the suite to that key (libsodium sealed box, as sealed-eval's owner tool
     does).
   - It prints the commitment and nothing from the suite.
   - The output file holds the commitment, the enclave key, the challenge, the ciphertext and the
     key-release quote. It is safe to publish.
   - The enclave key lives only as long as that enclave instance. If the enclave restarts, seal again.
3. **Register the suite** (optional; lets a bounty require a registered suite):
   `plumbline suite register sealed-suite.json`.
4. **Lock the reward.**
   ```
   plumbline bounty create --suite sealed-suite.json --reward 1 --target 2/3 --deadline-slots 216000
   ```
   - The SOL moves from your wallet into the bounty account, a program address that nobody holds a key
     for.
   - `--target` is the minimum accuracy, either `c/t` or a percent. The run must also cover at least `t`
     items.
   - `--grace-slots` sets how long after the deadline you must wait before a refund. This gives a score
     recorded just before the deadline time to be claimed.
   - `--pin-compose` and `--pin-image` accept scores from one exact enclave build and guest image only.
     Without them, a later change to the registry's approved enclave changes what your bounty pays for.
5. **Watch.** The web app lists the bounty and its leaderboard. You can also run
   `plumbline bounty show <address>`.
6. **Get paid out or refunded.**
   - The first verified score that meets the target takes the whole reward.
   - The score must be recorded after the bounty was created and no later than the deadline.
   - If nobody qualifies, run `plumbline bounty refund <address>` after the deadline plus the grace
     window.

## The entrant, step by step

1. **Pick a bounty** in the web app and get the sponsor's `sealed-suite.json`.
2. **Pin your model**: a public repository id, a 40-hex commit, and the sha256 of each weights file.
3. **Enter**, naming the Solana address that should receive the prize:
   ```
   plumbline enter --enclave https://<enclave> --sealed sealed-suite.json \
     --model org/name --revision <40-hex> --shard model.safetensors=<sha256> --payout <your address>
   ```
   - The enclave downloads exactly those weights, checks every hash, and scores the model against the
     sealed suite.
   - It then signs a statement that includes your payout address.
   - The CLI builds the score bundle and checks it: the statement hash, the quote's binding to the
     statement, the event log, and that the payout, model and suite are the ones you asked for.
   - It saves the bundle as `bundle-<hash>.json`. If any check fails, it says so and exits non-zero.
4. **Check the bundle yourself** if you like, on the web app's Verify page or with
   `plumbline verify bundle-<hash>.json`. Both check the TDX quotes against Intel's root.
5. **Hand the bundle to a relayer.** Drop it in the relayer's inbox or `POST` it to `/bundles`.
   - The relayer proves it (Groth16), calls `record_verified_score`, then `claim`s every open bounty the
     score meets.
   - You can also do the last step yourself once the score is recorded:
     `plumbline claim --bundle bundle-<hash>.json`.

## Why the prize can't be redirected

- The payout is a field of the attested statement.
- The quote's report data is `sha256("tessera:score:v1" || canonical(statement))`. The zk guest checks
  the quote, recomputes that binding, and puts the payout into its journal (bytes 298..330).
- The registry stores the payout in the `VerifiedScore`, and `claim` pays only that address.
- Whoever sends the claim (relayer, entrant or a stranger) pays the fee and gets nothing. Claim has no
  payout argument.
- There is no entrant registration, so registering someone else's public model first gets you nothing.
- A statement without a payout proves with a zero payout, and the escrow refuses to pay it (`NoPayout`).

## The relayer

The relayer is a service anyone can run. We run one by default. For each bundle (inbox directory or
`POST /bundles`) it:

1. **Checks the bundle locally** before it spends prover time:
   - the statement hash;
   - that the statement carries a non-zero payout;
   - that the score quote's report data binds the statement;
   - that every RTMR3 runtime event digest either recomputes or is empty, since dstack-cloud strips them
     and the guest recomputes them;
   - that there is exactly one compose-hash event.

   Off localnet it also runs the full Intel-chain check.
2. **Skips proving and recording** if the statement already has a `VerifiedScore` onchain.
3. **Runs the prover**, the `plumbline/zk` host, with a configurable command.
4. **Checks the proof's journal** against the bundle: statement hash, `bound = 1`, suite, score and
   payout.
5. **Calls `record_verified_score`.** If someone else recorded the score first, that is fine.
6. **Claims every open bounty on that suite** that the score meets. It runs the program's claim checks
   first, so it skips claims the program would reject.

Every step is logged as a JSON line. State is one JSON file keyed by statement hash, so a restart picks
up where it stopped: it reuses a finished proof and never pays twice.

The relayer's keypair only pays transaction fees. It never holds sponsor funds. Its config has no payout
setting, and it refuses one if you add it.

## The web app

The app is a static site (`plumbline/app`) with no build step and no wallet. It only reads the chain over
JSON-RPC. Every action is shown as the CLI command to run.

- **Bounties**: open bounties from `getProgramAccounts`, largest first.
- **Bounty**:
  - the terms;
  - the escrowed lamports;
  - a leaderboard of every `VerifiedScore` on the suite, best accuracy first and earlier slot on ties,
    with payout, slot, whether it can claim this bounty and why not, and an explorer link to the record;
  - the commands to enter, claim or refund.
- **Verify**:
  - drop a bundle and the page checks it in the browser with `tessera-verify.js`;
  - shows the payout inside the attested statement;
  - compares it with an address you type and with the onchain `VerifiedScore`;
  - lists which bounties that score can claim.
- **How it works**: the sponsor and entrant steps above.

## Running each piece

All three need Node 20+. Run `npm install` in `cli/` first; the relayer reuses the CLI's code and
dependencies.

```
# CLI
cd plumbline/cli && npm install
bin/plumbline --help                       # or: npx tsx src/main.ts --help
bin/plumbline --cluster devnet bounty list
bash scripts/localnet-smoke.sh             # real local validator + built programs: register, create, show, refund

# Relayer
cd plumbline/relayer && npm install
npx tsx src/main.ts --config relayer.json  # inbox polling + HTTP on 127.0.0.1:8787
npx tsx src/main.ts --once                 # process the inbox once and exit
```

Relayer config (JSON; all keys optional):

```json
{
  "cluster": "localnet",
  "keypair": "/path/to/fee-payer.json",
  "inbox": "inbox", "stateFile": "relayer-state.json", "workDir": "work", "logFile": "relayer.log",
  "port": 8787, "host": "127.0.0.1", "pollMs": 5000,
  "quoteCheck": "full",
  "prover": {
    "command": ["../zk/risc0/target/release/tessera-risc0-host", "groth16", "{quote}", "{statement}", "{event_log}"],
    "env": { "OUT": "{out}" },
    "timeoutMs": 10800000
  }
}
```

- `quoteCheck` defaults to `binding` on localnet and `full` elsewhere.
- `{quote}`, `{statement}`, `{event_log}`, `{out}` and `{dir}` are replaced per job.
- Environment overrides: `PLUMBLINE_CLUSTER`, `ANCHOR_WALLET`, `PLUMBLINE_PROVER_CMD` (a JSON array) and
  `PLUMBLINE_RELAYER_CONFIG`.

Web app:

```
cd plumbline/app && node test/serve.mjs 8080   # any static server works; ES modules don't load from file://
# open http://127.0.0.1:8080/?cluster=devnet   (or ?rpc=http://127.0.0.1:8899)
```

Program ids come from `plumbline/programs` (`target/idl`). The CLI and relayer read the IDLs directly.
The app keeps the two ids in `app/js/config.js`, and a test fails if they drift from the IDL.

Tests: `npm test` in `cli/` and `relayer/` (vitest), and in `app/` (headless Chromium from
`/opt/pw-browsers`).
