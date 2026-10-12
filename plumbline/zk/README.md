# Plumbline zk guest

RISC Zero guest + host from `sealed-eval-zk`, with the two proving-run fixes
(`sealed-eval-zk-fixes/guest-fixes.patch`, applied with `git apply`) and the Plumbline payout binding
(`../SPEC.md`). It turns a sealed-eval score into a Groth16 proof that the Plumbline registry
(`../programs/registry`, `record_verified_score`) checks onchain.

## What changed vs sealed-eval-zk

- **Payout.** The statement may carry `payout`: 64 lowercase hex chars, the 32 raw bytes of the entrant's
  Solana pubkey. The guest parses it from the canonical statement it already hashes into report_data, so
  it is covered by the quote binding. Absent = 32 zero bytes (the escrow refuses to pay that); present but
  not exactly 64 lowercase hex chars (or not a string) = `Error::Field("payout")`, no proof.
- **Journal 298 -> 330 bytes:** the old 298 bytes, unchanged in order, then `payout [32]`.
- **Empty dstack RTMR3 digests** (from the patch): runtime events (`event_type` 0x08000001) are replayed
  with `sha384(event_type.to_ne_bytes() || ":" || event || ":" || payload)`; an empty or missing digest is
  accepted, a provided digest that differs rejects the log. Other RTMR3 events still need a 48-byte digest.
- **Path-independent image ids** (from the patch): `methods/build.rs` sets `RUSTC_WRAPPER=methods/remap-rustc.sh`
  (`--remap-path-prefix` for the checkout dir and `CARGO_HOME`), and each guest reaches the lib through an
  in-workspace symlink `methods/guest*/tessera-zk-lib -> ../../../lib`.
- New fixtures: `statement-v1-payout.json` and `synthetic-quote-payout.bin` (bound to it),
  `synthetic-event-log-stripped.json` (all digests emptied), `payout-pubkey.txt`. `make_synthetic_quote.py`
  writes all synthetic fixtures under one fresh throwaway root, so `test-root.der` changed too.
- `scripts/prove-fixtures.sh` re-proves the three fixtures in `proofs/`; `scripts/bundle_to_inputs.py`
  (from the patch) splits a bundle into guest inputs.

## What the guest proves

Inputs: the enclave's score quote, `canonical(statement)` exactly as the enclave hashed it, and the dstack
event log returned with the quote. The guest (`lib/src/lib.rs`, `prove_score`):

1. Verifies the TDX v4 quote (`lib/src/tdx.rs`): PCK chain ends byte for byte in the pinned root (Intel
   SGX Root CA, sha256 `44a0196b...74d3`, or the test root in the TEST ONLY image), QE report signed by the
   PCK leaf, QE report binds the attestation key, attestation key signed header + TD report.
2. Requires canonical JSON (sorted keys, no whitespace), `v = tessera-score-1`; reads `suite_commitment`,
   `correct`, `n`, the model fields and the optional `payout`.
3. `bound` = quote `report_data[0..32] == sha256("tessera:score:v1" || canonical(statement))`.
4. Replays the event log into RTMR3 (above). If it equals the quote's RTMR3, `compose_hash` = payload of
   the runtime `compose-hash` event, else zero.

Journal (330 bytes, read by offset onchain): statement_hash 0 | model_id_hash 32 | suite_commitment 64 |
quote_hash 96 | mr_td (48) 128 | rtmrs_hash 176 | tee_tcb_svn (16) 208 | root_sha256 224 | correct u32 256 |
total u32 260 | binding_version u8 264 | bound u8 265 | compose_hash 266 | payout 298.

## Image ids (this tree)

| guest | image id |
|---|---|
| production (Intel root) | `0x68049079fafddc9192761eb4461fb8cb036e92275fb91aa7ef61801c975114c6` |
| test-root (TEST ONLY) | `0x7aaa8f274bbbc3501ecee9552592a47e35a3345bd2dc3b8314a7f500187699a7` |

Checked: a methods-only build from a copy at another path, with another target dir, gave the same
two ids. The registry config pins one of these. sealed-eval-zk (298-byte journal) had `0xe70d318f...3f64` /
`0x555e16e0...c3eb` after the fixes patch and `0xba73ed54...142b` / `0xcc40bec3...d4ef` before it.

## Proofs (`proofs/`)

| file | image | inputs | journal |
|---|---|---|---|
| `synthetic-payout-groth16.json` | test-root | `synthetic-quote-payout.bin`, `statement-v1-payout.json`, full event log | bound 1, compose `6e4be83a...56a2`, payout `G86RoeNm...3dfk` |
| `synthetic-nopayout-groth16.json` | test-root | `synthetic-quote.bin`, `statement-v1.json`, **stripped** event log | bound 1, same compose, payout zero |
| `intel-unbound-groth16.json` | production | `intel-real-quote.bin`, `statement-v1.json`, no log | bound 0, compose zero, payout zero |

Proved 2026-10-12 on a 4-core CPU box, Groth16 via Docker:

| proof | user cycles | segments | Groth16 |
|---|---|---|---|
| synthetic-payout | 1,864,430 | 3 | 19.8 min (1,186 s) |
| synthetic-nopayout | 1,777,559 | 2 | 18.7 min (1,120 s) |
| intel-unbound | 1,926,419 | 3 | 20.1 min (1,203 s) |

Proving peaks at about 11 GB of RAM in use on the box. Onchain, `record_verified_score` costs 120,367 CU in a
977-byte transaction (was 117,166 / 945 with the 298-byte journal).

## Build and run

Toolchain: RISC Zero 3.0.6; the risc0 Rust toolchain (rustc 1.88) linked as rustup toolchain `risc0`
(copied from `risczero/risc0-guest-builder:r0.1.88.0`). Groth16 needs Docker
(`risczero/risc0-groth16-prover:v2025-04-03.1`; start the daemon with `nohup dockerd > /tmp/dockerd.log 2>&1 &`).
Check out with git (the guest symlinks must survive).

```
(cd lib && cargo test && cargo test --features test-root)        # native, 7 + 16 tests
cd risc0 && cargo build --release      # about 40 min from scratch on 4 cores (risc0 C++ kernels)
IMAGE=testroot target/release/tessera-risc0-host execute ../fixtures/synthetic-quote-payout.bin \
  ../fixtures/statement-v1-payout.json ../fixtures/synthetic-event-log.json    # seconds; prints the journal
bash ../scripts/prove-fixtures.sh [payout|nopayout|intel|all]                  # Groth16, ~20 min each
target/release/tessera-risc0-host vk    # control root + BN254 control id for scripts/gen_vk.py
```

Native tests added for the payout: bound and in the journal at 298..330; edited (or dropped) payout is not
bound; absent = zeros (in the journal too); bad hex (uppercase, short, long, non-hex, empty, non-string)
rejected; the stripped fixture log proves the same journal as the full one.

## Still missing

- A real score proof from a Phala run (quote bound to a real statement with a payout; the approved
  compose hash from that deploy goes into the registry config).
- The enclave must put the entrant's `payout` into the statement it signs (`../enclave`); the guest only
  carries what the statement says.
- TCB status, QE identity, CRLs and certificate validity windows are not checked (need Intel collateral).
- v2 (TDX + NVIDIA GPU) statements are rejected by this guest.
- The challenge is not checked for freshness onchain.
- Proving takes about 20 minutes per score on a 4-core CPU box.
