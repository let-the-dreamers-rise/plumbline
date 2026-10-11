# zk: the private covenant proof (RISC Zero)

One RISC Zero guest checks three things and commits a short, fixed-layout journal. The proof is
wrapped in Groth16 so the Solana program `pct_oracle` can verify it onchain
(`oracle/programs/pct_oracle/src/instructions/zk.rs`, verifier in `src/risc0_groth16.rs`, VK from
risc0-groth16 3.0.5 in `src/risc0_vk.rs`).

| Path | What it is |
| --- | --- |
| `lib/` (`pct-zk-lib`) | The verification logic. Runs natively in `cargo test` and inside the zkVM. |
| `lib/src/gpu.rs` | NVIDIA Hopper SPDM `GET_MEASUREMENTS` report: GPU signature (P-384) and certificate chain to the pinned NVIDIA Device Identity CA. |
| `lib/src/tdx.rs` | Intel TDX v4 DCAP quote, structural checks (see Limitations). |
| `lib/src/revenue.rs` | Reclaim-format revenue claims: k-of-n attestor signatures (secp256k1), source pin, operator binding, currency, dating, dedupe, covenant math. |
| `lib/src/p384_risc0.rs` | P-384 on RISC Zero's bigint accelerator (the generic crate costs tens of millions of cycles per signature). |
| `risc0/methods/guest/` | The guest program `covenant`. |
| `risc0/host/` | Runs, proves or Groth16-wraps the guest on the fixtures. |
| `fixtures/` | Inputs and the committed Groth16 proofs used by the demo and the LiteSVM tests. |

## What the guest proves

Given private inputs, in this order (`risc0/methods/guest/src/main.rs`):

1. `report: Vec<u8>`: an NVIDIA H100 SPDM attestation report.
2. `chain: Vec<Vec<u8>>`: the GPU's certificate chain (DER), leaf first, ending in NVIDIA's root.
3. `claims: Vec<Claim>`: Reclaim zkFetch claims for the covenant window, each with every attestor signature it carries.
4. `attestors: AttestorSet`: threshold and attestor addresses.
5. `params_hash: [u8; 32]`: keccak of the zkFetch parameters of the one revenue source all claims must use.
6. `terms: Terms`: operator key, currency, period length, debt service per period, minimum coverage (bps), covenant window, `as_of_period`.
7. `quote: Vec<u8>`: the Intel TDX quote of the confidential VM.

the guest asserts, and aborts (no proof) otherwise:

- **GPU** (`gpu::verify_gpu`): the chain ends in the pinned NVIDIA Device Identity CA, every link is
  ECDSA-P384/SHA-384 signed by its parent (a pinned, natively verified upper chain lets the guest skip
  three links), and the report is signed by the leaf key.
- **VM** (`tdx::verify_tdx`): the PCK chain ends in the pinned Intel SGX Root CA, the QE report is
  signed by the PCK leaf and binds the attestation key, and the quote is signed by that key.
  `vm_result` then sets `vm_bound = 1` only if the quote's `report_data` is
  `sha256(GPU report) || GPU nonce`.
- **Revenue** (`revenue::check_covenant`): every claim uses the pinned source, carries at least
  `threshold` distinct signatures from the attestor set, belongs to `terms.operator_key`, matches the
  loan currency, is dated inside the window ending at `as_of_period` (1 to 13 periods), and is not a
  duplicate payment. Coverage is `revenue * 10000 / (window * debt_service)`; PASS if it is at least
  `min_coverage_bps`, otherwise WATCH (still a valid proof).

## The journal (public outputs)

262 bytes, fixed layout (`lib/src/lib.rs` `public_values`, read by offset in `zk.rs`):

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 32 | `chip_id`: sha256 of the GPU's BROM certificate serial |
| 32 | 32 | GPU nonce (the lender's challenge must equal it onchain) |
| 64 | 32 | sha256 of the signed measurement record (firmware, VBIOS, driver) |
| 96 | 32 | attestor set hash (threshold and addresses) |
| 128 | 32 | revenue source params hash |
| 160 | 32 | loan terms hash |
| 192 | 8 | **total window revenue**, u64 LE, micro units of the loan currency |
| 200 | 8 | coverage, bps, u64 LE |
| 208 | 4 | number of claims, u32 LE |
| 212 | 1 | pass (1) or watch (0) |
| 213 | 32 | VM measurement: `sha256(mr_td || sha256(rtmr0..3))` |
| 245 | 16 | TDX `tee_tcb_svn` |
| 261 | 1 | `vm_bound` |

**What is revealed.** Individual payments, payment ids, payout amounts and the raw GPU report stay
inside the proof. The **total revenue over the window is public**: it is in the journal in plaintext
(`lib.rs:61`, `r.revenue_micro.to_le_bytes()`) and the journal is sent as instruction data to
`prove_covenant`. Coverage times the (public) debt service also reveals it. The program stores only
status, coverage, claim count and the hashes, but the total is readable from the transaction. Fix
on the roadmap: commit only the pass bit and coverage band, or a salted hash of the revenue.

## Build and prove

Needs Linux or WSL2 (RISC Zero does not build guests natively on Windows), Rust, and the RISC Zero
toolchain for zkVM 3.0.x (`curl -L https://risczero.com/install | bash`, then `rzup install`).
The Groth16 step also needs Docker (x86_64), which RISC Zero uses for the STARK-to-SNARK wrap.

```bash
cd zk && cargo test                         # pct-zk-lib unit tests, native (no zkVM)
cd zk/risc0
cargo run --release -- execute              # runs the guest, prints image id, cycles and the journal
cargo run --release -- prove                # succinct STARK receipt
cargo run --release -- groth16              # Groth16 receipt for Solana (Docker)
```

Environment knobs (`risc0/host/src/main.rs`): `MONTH=strong|weak` picks the fixture claims,
`DEBT_SERVICE_MICRO` overrides the fixture loan's weekly debt service, `LABEL` is added to the output
name, `SEGMENT_PO2` sets the segment size (default 19). Groth16 output lands in
`zk/risc0/proofs/covenant-<MONTH>[-<LABEL>]-groth16.json` (git-ignored) with `imageId`, `journal`,
`journalDigest`, `seal` and `claimDigest`.

The committed proofs all come from image id
`0xbf16300e30e259e209e4ce657686ccd3cecc33abac275cd3d7450ce9a612bfe2`, and their journals decode to:

| File | Debt service (INR/week) | Revenue (INR, 4 weeks) | Coverage | Result |
| --- | --- | --- | --- | --- |
| `fixtures/covenant-strong-groth16.json` | 120,000 | 650,000 | 13,541 bps | PASS |
| `fixtures/covenant-strong-pass115-groth16.json` | 141,300 | 650,000 | 11,500 bps | PASS |
| `fixtures/covenant-strong-watch114-groth16.json` | 142,500 | 650,000 | 11,403 bps | WATCH |

All three have `vm_bound = 0`.

**Cycles and proving time.** `execute` prints the cycle count. No run log is committed. The product
site states about 10.75M guest cycles and 97 to 108 minutes per proof (Groth16 wrap included) on a
4-core, 15 GB cloud VM. Treat those as the author's measurements until a log is added. Onchain,
the LiteSVM test `real_proof_flips_the_loan_to_pass_and_unlocks_a_draw`
(`oracle/programs/pct_oracle/tests/zk.rs`) prints the `prove_covenant` compute units under
`cargo test -- --nocapture`. The demo transaction asks for a 1.4M CU limit.

## Known limitations

- **Sample GPU evidence.** The host always feeds NVIDIA's published sample H100 report
  (`fixtures/h100-sample-report.hex`, `h100-sample-certchain.pem`). It is a real NVIDIA-signed
  report, but not from a GPU answering a lender's challenge. The devnet demo sets the lender's
  challenge to the nonce already inside that report (`scripts/zk-devnet-demo.ts`). The host has no
  mode yet that takes an operator's own report, chain, quote and claims.
- **TDX quote not bound to the GPU.** The quote is VoltageGPU's published H200 Confidential VM quote
  (`fixtures/tdx/`). Its `report_data` is not `sha256(sample report) || nonce`, so `vm_bound = 0`
  (test `fixture_vm_is_not_bound_to_the_sample_gpu` in `lib/src/lib.rs`). The demo leaves the
  program's `require_vm_bound` off.
- **TDX checks are structural only.** As `lib/src/tdx.rs` says, TCB info and TCB status, QE identity,
  CRLs and certificate validity windows are **not** checked (they need Intel collateral). The
  `tee_tcb_svn` is committed so a later collateral check can use it. The GPU path likewise does not
  check certificate validity dates, revocation or NVIDIA's reference measurements (RIM). There is
  no dcap-rs dependency.
- **Test attestor keys.** The revenue claims in `fixtures/revenue-claims.json` are synthetic Razorpay
  payments signed by two deterministic test keys (`scripts/make-zk-fixtures.ts`; the second is
  `keccak256("pct-test-attestor-2")`). Anyone can derive these keys, so on a cluster configured with
  this attestor set anyone can forge revenue. Real use needs real Reclaim attestors (Reclaim runs one
  today, so a 2-of-n rule needs a second independent attestor).
- **Revenue total is public** (see above).
- **Unaudited.** The guest, the Groth16 verifier and the program have not been audited.

## Fixture expiry (read before a demo)

The fixtures are for week **2961** (`scripts/make-zk-fixtures.ts:10`, `AS_OF = 2961`; weeks are
`floor(unix_s / 604800)`, so week 2961 starts Thu 2026-10-01 00:00 UTC). The program accepts a
proof only if `as_of_period <= current && as_of_period + 1 >= current` (`zk.rs:207`), and
`draw_private` only while `as_of_period + 1 >= current` (`zk.rs:280`). `scripts/zk-devnet-demo.ts`
refuses to run on the same condition.

So the committed proofs are accepted only during weeks 2961 and 2962. **From 2026-10-15 00:00 UTC
(start of week 2963) `prove_covenant` refuses them with `NoRecentRevenue`, private draws on loans
proven with them are refused, and `npm run zk:devnet` exits before sending anything.** The LiteSVM
tests are not affected (they set the clock from the fixture's `as_of_period`).

A proof for week `W` is valid from the start of week `W` to the start of week `W + 2`. To regenerate
for the current week (Linux or WSL2 with the RISC Zero toolchain and Docker; about 1.5 to 2 hours
per Groth16 proof by the figure above):

```bash
# 1. Current week number
node -e 'console.log(Math.floor(Date.now() / 1000 / 604800))'
# 2. Set AS_OF in scripts/make-zk-fixtures.ts to that number, then rewrite the claims (repo root)
npx tsx scripts/make-zk-fixtures.ts         # writes zk/fixtures/revenue-claims.json
(cd zk && cargo test)                        # the lib tests use the new claims
# 3. Re-prove the two demo proofs (the image id does not change: the fixtures are not in the guest)
cd zk/risc0
MONTH=strong LABEL=pass115  DEBT_SERVICE_MICRO=141300000000 cargo run --release -- groth16
MONTH=strong LABEL=watch114 DEBT_SERVICE_MICRO=142500000000 cargo run --release -- groth16
cp proofs/covenant-strong-pass115-groth16.json proofs/covenant-strong-watch114-groth16.json ../fixtures/
# 4. Run the devnet demo within two weeks (repo root; program deployed, SOLANA_RPC_URL and SOLANA_KEYPAIR set)
cd ../.. && npm run zk:devnet                # writes zk-devnet-demo.json with explorer links
```

The debt-service values are the ones `scripts/zk-devnet-demo.ts` opens the two loans with; keep them
in step. Leave `oracle/programs/pct_oracle/tests/fixtures/` alone unless you also replace its
matching `zk-revenue-claims.json`, since those tests pin their own clock.
