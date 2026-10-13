# Threat model and self-review

This document covers what each program must guarantee, where in the code it does so, and what we already know is weak. It was written for the CertiK and Adevar Labs reviewers so the paid audit time goes to finding new problems, not re-deriving these. Line references are to commit 517d909.

## Actors and assets

| Actor | Trusted for | Not trusted for |
|---|---|---|
| Config authority (pct_oracle) | Attestor set, zk config, proof fee, device-registry flag | Moving loan funds (it has no instruction that does) |
| Lender | Funding its own loan, issuing the GPU challenge, withdrawing undrawn funds | Anything on another lender's loan |
| Borrower / operator | Drawing on its own loan | Drawing without a current PASS |
| Proof submitter | Nothing: `prove_covenant`, `record_verified_score` and `claim` are permissionless | |
| Sponsor (bounty) | Funding and, after the deadline plus grace, refunding its own bounty | Choosing the winner |

The assets are the lamports in `Loan` accounts, the treasury PDA and `Bounty` escrows, plus the integrity of the public `ZkCovenant` and `VerifiedScore` records that curators read.

## pct_oracle invariants

All references are to `oracle/programs/pct_oracle/src/instructions/zk.rs` unless another file is named.

- **I-1. A seal only counts for the pinned guest.**
  - `risc0_groth16::verify(seal, zk.image_id, public_values)` runs at :206, before the journal is parsed.
  - The journal length is checked at :210.
- **I-2. A proof is fresh and used once.**
  - The journal nonce must equal the lender's stored `gpu_challenge` and be non-zero (:228).
  - The challenge is zeroed after use (:259), so the same proof cannot be replayed on that loan.
- **I-3. A proof is for these terms, this attestor set and this revenue source.**
  - Attestor set: :229.
  - Source params: :231.
  - `terms_hash(loan, as_of_period)`: :232. This binds the operator key, currency, period, debt service, minimum coverage, covenant periods and the as-of period.
- **I-4. Results only move forward and stay recent.**
  - The as-of period must be the current or previous period (:237).
  - It may never go backwards (:238).
  - `draw_private` repeats the recency check at :319.
- **I-5. Funds leave a loan only through `draw_private`/`draw` (borrower, PASS) or `withdraw` (lender).**
  - All three keep the account rent-exempt.
  - `draw` refuses loans that have a private covenant account (`lending.rs:298`), so the weaker path cannot bypass the proof.
- **I-6. VM binding, when required, needs a pinned image.**
  - `set_zk_config` refuses `require_vm_bound` with an all-zero measurement (:92), because any TDX VM can write any report_data.
- **I-7. With the registry enforced, one GPU backs one loan.**
  - `bind_device` holds the chip-id PDA (`registry.rs:204`).
  - The nonce must have been claimed by this loan (`registry.rs:175`). Otherwise a second lender with identical terms could replay the victim's proof under the victim's nonce.
- **I-8. Fees.**
  - The fee is taken before verification. A failed proof reverts the whole transaction, so no fee is kept.
  - `withdraw_fees` is authority-only and keeps the treasury rent-exempt (:297).

## Sealed-eval registry and bounty invariants

- **S-1. Only a verified score can be paid.**
  - The bounty reads the score with an owner check, a discriminator check and a canonical-PDA check (`bounty/src/lib.rs:64-78`).
  - `record_score` writes a different account type, which `claim` refuses.
- **S-2. A verified score is bound to its quote.**
  - `record_verified_score` checks the statement hash, binding version, root, compose hash, MRTD (if pinned) and `correct <= total` before verifying the seal (`registry/src/lib.rs` around :182-190).
- **S-3. Only the wallet proven inside the score is paid.**
  - Payout equals `s.payout` and is non-default (`bounty/src/lib.rs:193-194`).
- **S-4. Score timing.**
  - A score recorded before the bounty existed (:192) or after the deadline (:190) cannot claim.
  - The sponsor's refund waits for the deadline plus a grace period (:233).
- **S-5. Config rotation.**
  - Only the registry's upgrade authority can initialise the config (`registry/src/lib.rs:367-368`).
  - A bounty can pin `required_image_id` and `required_compose_hash` so a later rotation cannot change what it pays for.

## Known weaknesses (our own findings; please confirm or refute)

| # | Severity (our guess) | Finding | Plan |
|---|---|---|---|
| T-1 | High before mainnet | `initialize_config` in pct_oracle (`admin.rs:5-20`) accepts any signer as the first authority. Between deploy and init, anyone can front-run it and own the attestor set and zk config. The registry program already gates this on the upgrade authority; the oracle does not. | Add the same `program_data.upgrade_authority_address` constraint before mainnet. Devnet was initialised in the deploy session. |
| T-2 | Medium | With the device registry off (the default in the devnet binary), I-7 does not hold. A PASS shows that a GPU answered this loan's challenge, not that it is pledged nowhere else, and a colluding lender can replay another loan's proof by re-issuing its revealed nonce. | Switch enforcement on at mainnet. Curators should read `ZkCovenant.chip_id` together with the registry flag. |
| T-3 | Medium | The proof attests one GPU per facility. A facility of many GPUs is represented by one challenged GPU (weekly fleet sampling is planned, not built). | Product limitation, stated in every submission text. |
| T-4 | Low | `draw` and `draw_private` have no credit limit beyond the funded balance. While PASS, the borrower can draw everything the lender funded. | By design for the demo: the lender controls exposure by funding. A per-period draw cap is on the roadmap. |
| T-5 | Low | The first 8 bytes of the journal tail (`zk.rs:214-217`) are not checked onchain. They are covered only through `terms_hash`'s `as_of_period`. | Confirm the guest's layout makes them redundant, or check them. |
| T-6 | Low | `bounty::claim` uses `checked_sub(amount).unwrap()` (`bounty/src/lib.rs:199`), which panics instead of returning a named error if the escrow was somehow underfunded. | Replace with an error. |
| T-7 | Low | There are two copies of the Groth16 verifier (`oracle/.../risc0_groth16.rs` and `plumbline/programs/registry/src/risc0_groth16.rs`). They differ only in hashing imports today, and drift between them would be silent. | Move them into one shared crate before the audit starts. |
| T-8 | Info | The revenue attestor set is two test keys and the GPU and TDX fixtures are public samples. There are no TCB-status or revocation checks in the guest yet. | Out of program scope, but it decides what a PASS means. |

## How to reproduce

See [SCOPE.md](SCOPE.md) and run [`./audit/run-tests.sh`](run-tests.sh). Use `--all` to also run the SBF build and the local-validator suites.
