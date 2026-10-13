# Audit scope

This is the package for the CertiK and Adevar Labs audit-credit applications (Colosseum Crypto World's Fair sidetracks). It is the same package either auditor would start from. Line counts are measured by [`loc.sh`](loc.sh) at commit 517d909. Re-run it to check the numbers against any later commit.

## In scope

### 1. `pct_oracle`: the lending covenant (priority)
Anchor program, `oracle/programs/pct_oracle`. Live on devnet as `2jvEsAiBYWPeiSzb54qMgBbtbQivQkK5ZiTkp2bgZ6kz`. The deployed binary is in `oracle/dist`. It holds lender funds and releases them only on a proof, so a bug here loses money.

| File | Lines | What it does |
|---|---:|---|
| `src/risc0_groth16.rs` | 175 | Our own Groth16 verifier for RISC Zero receipts (alt_bn128 syscalls). |
| `src/risc0_vk.rs` | 19 | The verifying key constants. |
| `src/instructions/zk.rs` | 333 | `set_zk_config`, `issue_gpu_challenge`, `prove_covenant` (fee, journal checks, replay guard), `draw_private`, `set_proof_fee`, `withdraw_fees` |
| `src/instructions/lending.rs` | 337 | `open_loan`, `fund_loan`, `submit_revenue`, `draw`, `withdraw` |
| `src/instructions/registry.rs` | 274 | Cross-lender device registry: nonce claims, `bind_device`, `release_device`, `set_device_registry` |
| `src/reclaim.rs` | 222 | Onchain Reclaim claim parsing and secp256k1 signer recovery |
| `src/state.rs` | 314 | Accounts: `Config`, `PriceSource`, `Loan`, books |
| `src/math.rs` | 268 | Coverage and index math |
| `src/instructions/admin.rs`, `submit.rs`, `buffer.rs`, `crank.rs` | 352 | Config, sources, observation submission, claim buffers, index crank |
| `src/lib.rs`, `constants.rs`, `error.rs`, `instructions.rs` | 278 | Entry points, seeds, errors |
| **Total** | **2,572** | |

### 2. Sealed-eval registry and bounty escrow (second scope)
These are in `plumbline/programs`. The registry is `Eicw3HXxXN7kckn5XB4WDGQG2c61BLf7X7QpGehLTgAW` and the bounty is `9mDieYQNR2L9xgaqS6LK26kxR26rA4R9UcFntG369RPf`, both on devnet since Oct 13.

| File | Lines | What it does |
|---|---:|---|
| `registry/src/lib.rs` | 572 | Suites, config (upgrade-authority gated), `record_verified_score` (Groth16 over an attested TDX score), `record_score` (unverified, never paid) |
| `registry/src/risc0_groth16.rs`, `risc0_vk.rs` | 176 | A second copy of the verifier (see T-7 in the threat model) |
| `bounty/src/lib.rs` | 437 | `create_bounty`, `claim` (pays the wallet bound inside the verified score), `refund` |
| **Total** | **1,185** | |

## Out of scope (reviewed separately, or trusted)

- **The RISC Zero guests** (`zk/`, `plumbline/zk`). They hold the NVIDIA SPDM/P-384 chain checks, the TDX DCAP v4 quote verification and the coverage computation. The programs trust their journals once the seal verifies, so a guest bug is a soundness bug. They are listed as the natural next scope.
- **The TDX competition enclave** (`plumbline/enclave`), the relayer, the CLI, the web apps and the TypeScript SDK.
- **RISC Zero's prover and trusted setup.** The verifying key is RISC Zero's published Groth16 key.

## Status an auditor should know

- **Deployments:** devnet only. Mainnet is refused in every script and is planned for Q1 2027, after the audit.
- **Lending demo inputs:** the GPU and TDX fixtures are public samples. The revenue claims are signed by two test attestor keys.
- **Sealed-eval proofs:** the devnet proof used a test root. The first real enclave score (22/30 on a sealed suite, in an Intel TDX VM on Google Cloud, verified to Intel's root) was proven and paid on a local chain on Oct 13.
- **Tests:** [`run-tests.sh`](run-tests.sh) runs them all.
  - pct_oracle: 26 unit tests in `src/` (all 26 pass: `cargo test --lib`, Oct 13 05:20 UTC) and 48 integration tests in `tests/`.
  - Sealed-eval programs: 39 Anchor tests on a local validator, using real Groth16 fixtures and forged accounts.
- **Our self-review:** [THREAT-MODEL.md](THREAT-MODEL.md) lists the invariants and what we already know is weak.
