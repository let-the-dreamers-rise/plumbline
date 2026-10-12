# Swarm (Bittensor SN124) validator scoring through an attested enclave

This folder holds a patch to Swarm's validator and how it was tested. It is a pilot design that was run
against a mock of Swarm's backend. **It is not live**: it has not run on a real TDX host or on Swarm's
network, and Swarm has not reviewed or adopted it.

## What it is
- **Upstream:** [github.com/swarm-subnet/swarm](https://github.com/swarm-subnet/swarm) at commit
  `38b36a2c55967e5e7abc66932fee696a39852bac` (Oct 5, 2026, version 5.1.6.5). Swarm is MIT-licensed,
  Copyright (c) 2025 Swarm; its licence is in [`LICENSE-swarm`](LICENSE-swarm). The patch contains
  context lines from Swarm's files.
- **Patch:** [`swarm-ironproof.patch`](swarm-ironproof.patch), applies with `git apply` on that commit.
  [`DIFFSTAT.txt`](DIFFSTAT.txt) has the counts: +30/−3 lines in three of Swarm's existing files and a new
  331-line `swarm/ironproof/` package.
- **Flag:** every behavioural change is behind `SWARM_IRONPROOF=1`. With it unset, Swarm runs as before.
- **Naming:** the patch was written when the product was called Ironproof, so its identifiers
  (`swarm/ironproof/`, `SWARM_IRONPROOF`, `IRONPROOF_SCORER_PATH`) keep that name.

## What it changes
Today a whitelisted validator receives each epoch's seed key from Swarm's backend and derives the
benchmark seeds itself. With the flag on, the backend hands out a single-use challenge instead. The
validator's Intel TDX enclave attests to that challenge, and the backend checks the quote (Intel root,
pinned measurements), the hotkey signature, the validator permit and the stake before sealing the key to
the enclave. Seeds are derived, flown and scored with Swarm's own `evaluate_rollout` inside the enclave,
and each result goes back with a quote-bound per-seed report. Weights still come from Swarm's own KotH
combine and `set_weights`.

**Not runnable from this repository alone.** The patch imports Plumbline's scorer package
(`subnet-scorer`: the key server, the enclave app, the quote and report verifiers) from
`IRONPROOF_SCORER_PATH`. That package is the attested-scoring prototype, and it is not in this
repository yet, so a reviewer can read the patch and its tests but cannot rerun them from here.

## How it was tested, and what was mocked
- Swarm's real `forward()` loop and `BackendApiClient` ran over HTTP against a **mock backend** (Swarm's
  backend is private), with two validators scoring and a third refused for low stake.
- The TDX device was mocked with a recorded real Intel TDX quote; forged and mismatched reports were
  rejected, and a post-reveal audit reproduced every score.
- The flight is a point-mass stand-in, not Swarm's PyBullet simulator.
- Swarm's own validator tests gave identical per-test outcomes before and after the patch with the flag off.

## Still needed for a live pilot
A real TDX host, PyBullet and the miner policy format inside the enclave image, the matching routes in
Swarm's private backend, and production attestation collateral (TCB, QE identity and CRL checks).
