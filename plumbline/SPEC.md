# Plumbline product spec (v0.1, Oct 12 2026)

Plumbline runs private-data model competitions where the prize pays itself. A sponsor locks a reward
against a sealed test set. Anyone enters a model. A TDX enclave scores the model on the test set without
anyone (us included) seeing the questions, a zk proof checks the enclave's quote on Solana, and the escrow
pays the entrant's own wallet the moment a verified score meets the target.

This folder is the complete product. It is built on branch `claude/plumbline-product`, cut from the
frozen submission head `5cdc434`. Protocol strings (`tessera:*`, `tessera-score-1`) are unchanged.

## The flow

1. **Sponsor** seals a suite to the enclave key, registers the suite commitment, and creates a bounty
   (`plumbline bounty create`). Money sits in the bounty PDA.
2. **Entrant** submits `(model_id, revision, weights_sha256, payout)` to the competition enclave
   (`plumbline enter`). The enclave fetches the pinned weights, checks the hash, scores against the
   sealed suite and returns `{statement, quote, event_log}`. The statement carries `payout`.
3. **Relayer** (anyone, us by default) turns the bundle into a Groth16 proof, calls
   `record_verified_score`, then `claim`. It cannot redirect money: the payout is inside the proof.
4. **Web app** shows open bounties, a leaderboard per bounty, and a verify page that checks a bundle in the
   browser and links to the onchain record.

## Interface changes (the payout fix)

The gap: today the bounty pays whoever registered `model_id_hash` first, so anyone can register a public
model before its owner. Fix: bind the payout address into the attested statement.

### Statement (enclave, competition mode)

Same `tessera-score-1` statement, plus one field:

| field | value |
|---|---|
| `payout` | 64 lowercase hex chars: the 32 raw bytes of the entrant's Solana pubkey |

`report_data = sha256("tessera:score:v1" || canonical(statement))` as before. A statement without
`payout` is still valid v1 and proves with payout = 32 zero bytes, which the escrow refuses to pay.

### Journal (zk guest): 298 -> 330 bytes

The existing 298 bytes, unchanged in order, followed by `payout [32]` (zeros if absent). The guest
parses `payout` from the canonical statement it already hashes, so it is covered by the quote binding.
New guest => new image id; the product registry pins the new one.

### Registry (`plumbline/programs/registry`)

`JOURNAL_LEN = 330`. `VerifiedScore` gains `payout: Pubkey`. Everything else as sealed-eval-registry.

### Escrow (`plumbline/programs/bounty`)

- `claim` pays `verified_score.payout`. It refuses a zero payout (`NoPayout`).
- `register_entrant` and the `Entrant` account are removed; front-running is gone because the
  payout is proven, not registered.
- New check: `score.slot >= bounty.created_slot` (`ScoreBeforeBounty`), so an old score can't snipe a
  new bounty without the bounty opting in.
- Everything else as sealed-eval-bounty: pinned registry owner, discriminator, canonical PDA, suite,
  optional compose/image pins, cross-multiplied target, min total, deadline, grace, refund, first to
  meet the target wins.

### Also folded in (from the proving runs)

- Image id independent of the build path (`--remap-path-prefix` or docker build).
- dstack-cloud's empty RTMR3 digests: compute the digest when the event's digest is empty.

## Layout

```
plumbline/
  SPEC.md            this file
  zk/                guest + host (from sealed-eval-zk) with payout + both fixes
  programs/          Anchor workspace: registry + bounty
  enclave/           competition-mode enclave (from sealed-eval-board): POST /enter
  relayer/           watch -> prove -> record -> claim
  cli/               plumbline CLI (sponsor + entrant)
  app/               web app: bounties, leaderboard, verify
  docs/              what's real today vs pending
```

## Real today vs pending

See [docs/REAL-VS-PENDING.md](docs/REAL-VS-PENDING.md). In short: the whole flow has run end to end on a local
validator with a real Groth16 proof (test-root quote, stand-in model); the real Intel-signed score and the
devnet deploy are next.
