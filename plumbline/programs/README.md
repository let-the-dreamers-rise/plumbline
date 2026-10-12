# Plumbline programs (Anchor 0.31.1)

One Anchor workspace with the two onchain programs of the Plumbline flow (see `../SPEC.md`):

| Program | Crate / IDL | Id (localnet; keypair in `target/deploy/`) |
|---|---|---|
| registry | `registry/`, `target/idl/plumbline_registry.json` | `Eicw3HXxXN7kckn5XB4WDGQG2c61BLf7X7QpGehLTgAW` |
| bounty | `bounty/`, `target/idl/plumbline_bounty.json` | `9mDieYQNR2L9xgaqS6LK26kxR26rA4R9UcFntG369RPf` |

TypeScript types: `target/types/plumbline_registry.ts`, `target/types/plumbline_bounty.ts`. Both ids are new
keypairs; nothing is deployed outside a local validator.

## What changed vs the originals

**registry** (from `sealed-eval-registry`):

- `JOURNAL_LEN = 330`: the guest journal (`../zk`) is the old 298 bytes followed by `payout [32]`.
- `VerifiedScore.payout: Pubkey`, placed after `unix_timestamp` and before `bump` (379 bytes of fields
  after the 8-byte discriminator). It is all zero for a statement without `payout`; the registry records
  such a score anyway (it is a valid v1 statement), the escrow refuses to pay it.
- `VerifiedScoreRecorded` carries `payout`.
- Everything else is unchanged: upgrade-authority `init_config`, `set_config`, image id / root / compose /
  optional mr_td checks, `bound = 1`, write-once `["verified", statement_hash]`, `record_score`, suites.
  The Groth16 verifier and verifying key are the same files.

**bounty** (from `sealed-eval-bounty`):

- `claim` pays `verified_score.payout`. Accounts: `bounty` (mut), `verified_score`, `payout` (mut),
  `cranker` (signer). The `payout` account must equal the proven payout (`BadPayout`); a zero payout is
  refused (`NoPayout`).
- `register_entrant` and the `Entrant` account are removed. The payout is proven inside the attested
  statement, so there is nothing to front-run or squat; `WrongEntrant` and `EntrantRegisteredTooLate` are gone.
- New check `score.slot >= bounty.created_slot` (`ScoreBeforeBounty`): a score recorded before the bounty
  existed cannot take it. There is no opt-in flag for older scores.
- `REGISTRY_PROGRAM_ID` pins the new registry id; the `VerifiedScore` mirror has the `payout` field.
- Unchanged: registry owner + Anchor discriminator + canonical PDA checks, suite, optional compose / image
  pins, cross-multiplied target with the `min_total` floor, deadline, claim grace, sponsor-only refund after
  `deadline + grace`, first score to meet the target wins, `Bounty` account layout.

Claim check order: `AlreadyPaid`, `ScoreNotFromRegistry`, `NotAVerifiedScore`, `BadScorePda`, `WrongSuite`,
`WrongEnclave` (compose, then image), `BelowTarget`, `ScoreAfterDeadline`, `ScoreBeforeBounty`, `NoPayout`,
`BadPayout`. Error codes start at 6000 in enum order; read them from the IDL.

## Tests

Fixtures in `tests/fixtures/` (proofs copied from `../zk/proofs/`):

- `synthetic-payout-groth16.json`: test-root guest, synthetic TDX quote bound to a 4/6 statement whose
  `payout` is `G86RoeNmR7dTKjxsqhZZBnh15mvQgfU7W3BCnCcS3dfk` (a throwaway localnet key).
- `synthetic-nopayout-groth16.json`: test-root guest, synthetic quote bound to the same statement without
  `payout` (journal payout = zeros), proven from the dstack log with stripped (empty) digests.
- `intel-unbound-groth16.json`: production guest, real Intel quote not bound to our statement (`QuoteNotBound`).
- `forged/*.json`: two forged 6/6 `VerifiedScore` accounts loaded at genesis (`scripts/make-forged.ts`).

```
export PATH=/opt/solana-2.1.21/solana-release/bin:/opt/anchor-0.31.1:$PATH
yarn install --ignore-engines
bash scripts/localnet-test.sh            # SKIP_BUILD=1 reuses target/; RPC_PORT=8999 to run beside another validator
cargo test -p plumbline-registry --lib   # native Groth16 verify of the payout proof
cargo test -p plumbline-bounty --lib     # target math, discriminator, VerifiedScore mirror layout, pinned id
```

`localnet-test.sh` runs two phases, each on a fresh `solana-test-validator` with real upgradeable deploys
(a proof can be recorded once per ledger): `tests/registry.ts` + `tests/verified.ts`, then `tests/bounty.ts`
with the forged accounts. Plain `anchor test` misreports port 8899 as in use in this container. `/mnt` is
mounted noexec, so build and run from `/home`.

## Results (2026-10-12, Solana 2.1.21, Anchor 0.31.1, localnet only)

`RPC_PORT=8999 bash scripts/localnet-test.sh` (fresh `anchor build`, both phases): **39 passing, 0 failing**
(20 in registry.ts + verified.ts, 19 in bounty.ts), `LOCALNET OK`. Native: `plumbline-registry` 3 passed
(Groth16 verify of the payout proof, claim digest, id), `plumbline-bounty` 5 passed.
`record_verified_score` 120,367 CU in a 977-byte transaction; `claim` 12,120 CU.
Two consecutive builds gave the same binaries: registry `.so` sha256 `29187877...36f9`, bounty `304be748...5223`.

| Case | Expected | Result |
|---|---|---|
| registry: upgrade-authority-only init, admin-only set_config, wrong root, edited score byte, edited payout byte, bad seal, 298-byte journal, statement mismatch, other compose / mr_td, other image, real Intel quote not bound | `NotUpgradeAuthority`, `NotAuthor`, `WrongRoot`, `BadProof` x3, `BadJournal`, `JournalMismatch`, `WrongEnclave` x2, `BadProof`, `QuoteNotBound` | pass |
| registry: payout proof recorded, every field (payout included) from the journal; no-payout proof recorded with payout = zero; replay of either | `already in use` on replay | pass |
| bounty: bad terms | `BadTarget`, `ZeroAmount`, `MintNotSupported`, `DeadlineInPast`, `ZeroHash`, `SuiteNotRegistered` | pass |
| escrow = rent + amount; real proofs recorded through the registry; record replay | `already in use` | pass |
| happy path: a relayer cranks `claim`, 1 SOL lands on the proven payout; redirect to the relayer or sponsor | `BadPayout` | pass |
| replayed claim (same / other cranker) | `AlreadyPaid` | pass |
| score without payout (real proof) | `NoPayout` | pass |
| wrong payout account on an otherwise valid claim | `BadPayout` | pass |
| below target (5/6, 667/1000), wrong suite, score after deadline | `BelowTarget`, `WrongSuite`, `ScoreAfterDeadline` | pass |
| bounty created after the score | `ScoreBeforeBounty` | pass |
| bounty pins another compose hash / guest image | `WrongEnclave` | pass |
| forged score off-registry / registry-owned off-PDA / unverified ScoreRecord, Suite, Config / wallet | `ScoreNotFromRegistry`, `BadScorePda`, `NotAVerifiedScore`, `ScoreNotFromRegistry` | pass |
| refund before deadline, after deadline but inside grace, wrong signer, after paid | `RefundTooEarly` x2, `NotSponsor`, `AlreadyPaid` | pass |
| refund after deadline + grace returns escrow + rent, closes the bounty; a later claim | `AccountNotInitialized` | pass |

## Not done

- USDC / SPL (`mint` must be `None`), "best at deadline", splitting, closing a paid bounty.
- No opt-in for scores recorded before a bounty (SPEC mentions opting in; the check is unconditional).
- No audit; nothing deployed beyond a local validator. The payout proofs use the TEST ONLY test-root guest
  and a synthetic quote; a real Phala score is still to come (`../zk/README.md`).
