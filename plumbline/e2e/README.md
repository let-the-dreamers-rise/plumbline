# Plumbline end-to-end test (localnet)

`run-e2e.sh` runs the whole Plumbline flow from scratch on one machine: a sponsor sets up a bounty, an
entrant enters a model, the relayer proves the score with the real RISC Zero prover, and the escrow pays
the entrant's own fresh wallet. Then the web app shows the paid winner. `last-run.txt` is the transcript
of a passing run. `e2e-bounties.png` and `e2e-bounty.png` are the screenshots from that run.

```
nohup dockerd > /tmp/dockerd.log 2>&1 &          # if Docker is not running (Groth16 runs in Docker)
(cd ../cli && npm install); (cd ../relayer && npm install); (cd ../app && npm install)   # if missing
E2E_ZK_TARGET=<existing risc0 3.0.6 target dir> bash run-e2e.sh 2>&1 | tee last-run.txt
```

Runtime is about 25 minutes, most of it Groth16 proving. Proving needs about 11 GB of RAM. Without a warm
`E2E_ZK_TARGET`, the first prover build compiles risc0 from scratch: that takes about 40 minutes and
needs about 3 GB of disk in `~/.cache/plumbline-e2e/zk-target`.

`STOP_AFTER=execute` stops after the guest execute check (step 4a), at about 90 seconds, without proving.
Ports: `RPC_PORT` (8999, faucet +1010), `ENCLAVE_PORT` (18080), `APP_PORT` (18081). All keys are fresh and
live in a temp work dir. The ledger, the work dir and the zk copies are deleted on exit; `KEEP_WORK=1`
keeps the work dir but still deletes the ledger.

## What it proves

All of these are the real code from this branch, with no mocks between them:

1. **Programs.** `plumbline_registry` and `plumbline_bounty` from `programs/target/deploy` are deployed
   as upgradeable programs to a fresh `solana-test-validator`. The registry config is initialised by the
   upgrade authority with the guest image id, the root sha256 and the enclave compose hash.
2. **Enclave.** The competition enclave is `enclave/enclave/server.py`, imported unmodified, serving
   `/health`, `/attest` and `/enter` over HTTP. It runs its own request parsing, payout check, host and
   redirect checks, size limits and per-shard sha256 check, and it builds the statement with `payout`.
3. **Sponsor, using the plumbline CLI.**
   - `seal` fetches `/attest` with a fresh challenge, checks the key-release binding and seals a
     throwaway suite.
   - `suite register` registers it.
   - `bounty create` escrows 0.5 SOL for 4/6, with `--require-registered-suite` and pins to the
     enclave compose hash and guest image.
4. **Entrant, using the plumbline CLI.** `enter` passes a fresh payout keypair that is never funded. The
   CLI checks the returned bundle (binding, payout, model and suite) and saves it.
5. **Guest execute.** Before proving, the guest runs on the bundle (`zk/scripts/bundle_to_inputs.py`,
   then `execute`). The journal must show:
   - `bound = 1`;
   - the e2e root;
   - the compose hash from the replayed RTMR3 event log, which is non-zero only if the replay equals
     the quote's RTMR3;
   - the entrant's payout.
6. **Relayer.** `relayer --once` runs the real prover host in Groth16 mode (Docker stark-to-snark), then
   `record_verified_score`, then `claim`. It runs with its own fee-payer wallet.
7. **Onchain checks** (`chain_tool.ts check`):
   - the `VerifiedScore` exists for the entrant's statement, with `payout` = the entrant's key;
   - the bounty is `paid`, and its winner is that statement and payout;
   - the payout wallet's balance went up by exactly the bounty amount;
   - the relayer's balance only went down (fees);
   - in the claim transaction, the payout gained exactly the amount and the relayer gained nothing.
8. **Web app.** `app/test/serve.mjs` serves the app, pointed at the local RPC with `?rpc=`, and headless
   Chromium from `/opt/pw-browsers` opens it. The list, with "show paid bounties" ticked, must show the
   bounty as paid. The bounty page must show the winner's payout.

## What it fakes

| Piece | Here | In production |
|---|---|---|
| TDX quote | A TEST ONLY quote laid out like a real TDX v4 quote, built the way `zk/fixtures/make_synthetic_quote.py` builds one. Header and TD body (mr_td, RTMR0-2, TCB) are copied from the real Intel quote; report_data and RTMR3 are set; it is signed by a throwaway PCK chain under a **fresh e2e test root**. | Intel-signed quote from Phala TDX, checked against Intel's SGX root |
| dstack | A stub `dstack_sdk` module (`enclave_host.py`) that returns that quote plus a dstack-style RTMR3 event log. The log's replay equals the quote's RTMR3, and its `compose-hash` event carries `sha256(docker-compose.compete.yml)` as a stand-in. | dstack's GetQuote and the real `app-compose.json` hash |
| Guest | The repo's test-root guest, with only `fixtures/test-root.der` swapped for the e2e root (see below) | The production guest that pins Intel's root |
| Model | `load_weights` and `answer` are replaced by a fake model: a regex solver for the `gen_suite.py` question templates. It has no torch and no transformers. Its "weights" are a small byte blob, pinned by sha256 like real shards. | Real transformers model loaded with `trust_remote_code=False` |
| HTTPS | `server._open` is replaced by a fake huggingface.co with a 302 to an LFS-style `cdn-lfs.hf.co` URL. The enclave's own host, redirect, size and sha256 checks run for real on it. | huggingface.co and its CDNs |
| Suite | A throwaway suite from `enclave/gen_suite.py` (6 items) written to the temp dir. It is never printed, and no real suite is read. | The sponsor's private suite |
| Intel check in `seal` | `--skip-intel-check` (localnet only); the key-release binding is still checked | Full Intel chain check |
| Chain | `solana-test-validator`; every wallet is fresh and airdropped | devnet / mainnet |

### Why the prover is rebuilt instead of using the test-root binary as is

The repo's test-root guest pins `zk/fixtures/test-root.der`. `make_synthetic_quote.py` generated that
root's private key in memory and never saved it, so no new quote can chain to that root. The quote has
to bind this run's statement, with its fresh payout and challenge, so the e2e cannot reuse the repo's
fixtures. A prebuilt test-root host binary, such as `/dev/shm/plumbline-bin/tessera-risc0-host`, can
only prove the repo's fixture quotes.

So the e2e does the following:

- `mint_test_root.py` mints a new throwaway root, PCK CA and PCK leaf, and keeps the PCK leaf key in the
  temp work dir.
- `build-prover.sh` copies `zk/` (lib, risc0 sources, fixtures) and replaces only
  `fixtures/test-root.der`, then builds the host. Before building, it `diff -r`s the copy against the
  repo to confirm nothing else differs.
- As a control, `run-e2e.sh` first builds the same copy with the repo's own root and requires the
  repo's documented test-root image id.

| Build | Root | Test-root image id |
|---|---|---|
| repo (`zk/README.md`), and the e2e control build | `zk/fixtures/test-root.der` (sha256 `e2c78a5b...8226`) | `0x7aaa8f274bbbc3501ecee9552592a47e35a3345bd2dc3b8314a7f500187699a7` |
| e2e build | fresh root minted each run | differs every run (`0x3a2c919e...c5f6` in `last-run.txt`); the registry config pins it for that run |

Same guest code, a different embedded root. Neither image is the production guest, which pins Intel's
root.

## Files

| File | Role |
|---|---|
| `run-e2e.sh` | the whole flow |
| `mint_test_root.py` | throwaway PCK chain whose leaf key is kept, for the stub dstack |
| `build-prover.sh` | copies `zk/`, swaps in the e2e root, builds `tessera-risc0-host`, and writes the test-root image id |
| `enclave_host.py` | runs the unmodified `server.py` with the stub dstack, the fake HTTPS host and the fake model |
| `chain_tool.ts` | `init-config`, `balances`, and the onchain `check`, built on the CLI's `PlumblineChain` |
| `screenshots.mjs` | headless Chromium screenshots of the bounty list and the bounty page |
| `last-run.txt` | transcript of the passing run (public keys and signatures only, no key material) |
| `e2e-bounties.png`, `e2e-bounty.png` | screenshots from that run |
