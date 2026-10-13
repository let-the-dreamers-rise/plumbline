# What is real today, and what waits for the first real enclave run

The first real run moved from Phala to a self-hosted dstack-cloud TDX VM on Google Cloud (same Intel TDX,
same measured compose; runbook in the project's `plumbline-gcp/`). "Real enclave run" below means that.

Status on Oct 13 2026, branch `claude/plumbline-product`. "Tested" means an automated test in this
folder. "Exercised" means run once by hand, as described.

## Summary

| Piece | Today | After one real enclave run |
|---|---|---|
| Programs, escrow, payout binding | 39 tests on a local validator using real 330-byte Groth16 proofs from the test-root guest | Same |
| Full flow: bounty, entry, proof, record, payout | **Ran end to end on a local validator** (`plumbline/e2e/`): real competition enclave code, real Groth16 proof (20.5 min), `record_verified_score`, `claim` paid 0.5 SOL to the wallet named in the proof; the relayer got only fees. Quotes were signed by a throwaway test root and the model was a stand-in | Same flow with an Intel-signed quote and a real model |
| zk guest on a real Intel quote | Verifies Intel's sample quote (real Groth16 proof with the production image); statement binding tested with synthetic quotes | A real TDX quote bound to a real score |
| Enclave competition mode | Tested with a stub quote; the measured compose booted on a Google Cloud TDX VM once (Oct 13), but no score was taken because our build server could not reach it | A real score from the measured compose |
| Onchain payout on a public chain | Not yet: devnet deploy kit is ready and rehearsed, waiting on the deploy wallet | Devnet bounty paid from a real proof |

## The user-facing pieces (cli/, relayer/, app/)

| Piece | Today | After one real enclave run |
|---|---|---|
| `plumbline bounty create / show / list / refund`, `suite register` | Exercised on a real `solana-test-validator` with the built `plumbline_registry` and `plumbline_bounty` deployed (`cli/scripts/localnet-smoke.sh`: register, create with a required registered suite, list, show, refund refused before the deadline, refund after it). Argument parsing tested with a mocked chain. | Same commands with `--cluster devnet` against the devnet deploy |
| `plumbline record`, `plumbline claim` | Tested with a mocked chain, and **run on a local validator** in the e2e run with a real 330-byte proof: record, then claim paid the proven payout | Record and claim on devnet from the real proof |
| `plumbline seal` | Tested: sealed box opens with the enclave's secret key; the commitment equals `sha256` of Python-canonical JSON; the attestation binding (`tessera:keyrelease:v1`) is checked; the suite is never printed. Intel-chain check of the key-release quote implemented with the same verifier as the web app; tested only to reject a stub quote | Seal against the real enclave's `/attest`; the Intel check passes on a real quote |
| `plumbline enter` | Tested against a local stand-in for `POST /enter`. It sends the request shape the enclave lane described: `{challenge, sealed, model_id, revision, weights, payout (64 hex), dtype}`. It assembles the bundle and rejects a statement whose payout differs from the one asked for. Also run in the e2e flow against the real competition enclave code with a stub quote source | One real entry on a TDX VM returns a bundle that passes `plumbline verify` with the full Intel check |
| `plumbline verify` | Binding checks tested on synthetic bundles, including dstack-cloud's stripped runtime digests. The full check reuses the unchanged `tessera-verify.js`; synthetic bundles fail it at the Intel root, as they should | A real enclave bundle passes the full check |
| Relayer pipeline (check → prove → record → claim) | Ran once for real in the e2e flow (real Groth16 prover, local validator). Also tested with the prover and chain mocked. Covers the happy path, idempotency (no second proof, record or payment), a lost record race, rejected bundles, a proof journal whose payout or binding doesn't match, reuse of a proof after a crash, HTTP `POST /bundles`, and the prover subprocess with placeholder substitution | Run against devnet with the real `tessera-risc0-host` (Groth16 needs its Docker prover, ~20 min per proof on a 4-core box) |
| Relayer cannot redirect money | Structural: claim has no payout argument; the CLI and relayer pass `VerifiedScore.payout`; the relayer config refuses a `payout` key; the relayer refuses to crank if the onchain payout differs from the bundle's. Tested | Same |
| Web app | Headless Chromium test with a stubbed RPC: bounty list, detail with leaderboard order, winner and claimability, verify page (binding pass, Intel fail on the stub quote, onchain payout match, expected-address mismatch), phone width without horizontal scroll, dark mode, mainnet refused without any RPC call. Account decoding pinned to the built IDLs by a test | Point it at devnet and see the paid bounty with the real score on its leaderboard |
| Mainnet | Refused by name, by URL and by genesis hash (CLI and relayer), and by name and URL (app). Tested | Still refused |

## Known gaps

- **Browser verifier and stripped digests.** The browser verifier (`tessera-verify.js`, copied unchanged)
  does not itself handle dstack-cloud's empty RTMR3 digests. The verify page and `plumbline verify`
  recompute them before calling it, the same way the zk guest does. That path is tested only on synthetic
  logs.
- **`plumbline enter` checks the binding only.** It does not run the Intel check, so its own check
  covers only the score quote's binding, not that it is a genuine quote. `plumbline verify` (full by
  default) and the relayer off localnet run the Intel check.
- **No wallet in the app.** v0 shows CLI commands instead of signing in the browser.
- **USDC.** The bounty program reserves a mint slot, but only lamports are supported; the CLI has no
  `--mint`.
