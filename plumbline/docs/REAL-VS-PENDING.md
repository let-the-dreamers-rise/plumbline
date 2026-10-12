# What is real today, and what waits for the Phala run

Status on Oct 12 2026, branch `claude/plumbline-product`. "Tested" means an automated test in this
folder. "Exercised" means run once by hand, as described.

## The SPEC table (unchanged)

| Piece | Today | After one Phala run |
|---|---|---|
| Programs, escrow, payout binding | Tested on localnet with a Groth16 proof from the test-root guest | Same |
| zk guest on a real Intel quote | Verifies Intel's sample quote; statement binding tested with a synthetic quote | A real Phala quote bound to a real score |
| Enclave competition mode | Tested with a stub quote | Measured compose running on Phala TDX |
| Onchain payout from a real score | Not yet | Devnet bounty paid from a real proof |

The first three rows belong to the programs, zk and enclave lanes. This folder doesn't change them.

## The user-facing pieces (cli/, relayer/, app/)

| Piece | Today | After one Phala run |
|---|---|---|
| `plumbline bounty create / show / list / refund`, `suite register` | Exercised on a real `solana-test-validator` with the built `plumbline_registry` and `plumbline_bounty` deployed (`cli/scripts/localnet-smoke.sh`: register, create with a required registered suite, list, show, refund refused before the deadline, refund after it). Argument parsing tested with a mocked chain. | Same commands with `--cluster devnet` against the devnet deploy |
| `plumbline record`, `plumbline claim` | Tested with a mocked chain that applies the program's claim checks. **Not yet run on chain**: no 330-byte plumbline proof exists yet (`programs/tests/fixtures/synthetic-payout-groth16.json` was still a 298-byte placeholder when this was written) | Record and claim on devnet from the real proof |
| `plumbline seal` | Tested: sealed box opens with the enclave's secret key; the commitment equals `sha256` of Python-canonical JSON; the attestation binding (`tessera:keyrelease:v1`) is checked; the suite is never printed. Intel-chain check of the key-release quote implemented with the same verifier as the web app; tested only to reject a stub quote | Seal against the live Phala enclave's `/attest`; the Intel check passes on a real quote |
| `plumbline enter` | Tested against a local stand-in for `POST /enter`. It sends the request shape the enclave lane described: `{challenge, sealed, model_id, revision, weights, payout (64 hex), dtype}`. It assembles the bundle and rejects a statement whose payout differs from the one asked for. **Not run against the real competition enclave** | One real entry on Phala returns a bundle that passes `plumbline verify` with the full Intel check |
| `plumbline verify` | Binding checks tested on synthetic bundles, including dstack-cloud's stripped runtime digests. The full check reuses the unchanged `tessera-verify.js`; synthetic bundles fail it at the Intel root, as they should | A real Phala bundle passes the full check |
| Relayer pipeline (check → prove → record → claim) | Tested with the prover and chain mocked. Covers the happy path, idempotency (no second proof, record or payment), a lost record race, rejected bundles, a proof journal whose payout or binding doesn't match, reuse of a proof after a crash, HTTP `POST /bundles`, and the prover subprocess with placeholder substitution | Run against devnet with the real `tessera-risc0-host` (Groth16 needs its Docker prover, ~20 min per proof on a 4-core box) |
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
