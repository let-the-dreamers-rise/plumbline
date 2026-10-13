# Plumbline for Superteam India

**Team:** a solo student founder in India, building since Sep 14, 2026 and full-time from Oct 13, 2026.

## What is built
- **Lending covenant.** One RISC Zero proof shows a real NVIDIA H100 answered the lender's challenge inside a measured Intel TDX VM, and that its payouts cover the loan. Our Anchor program verifies the proof on Solana and opens or refuses the next draw. It is live on devnet as `2jvEsAiBYWPeiSzb54qMgBbtbQivQkK5ZiTkp2bgZ6kz`, with five transactions in the [README](../README.md).
- **Sealed evals, the same engine extended.** A score registry and bounty escrow pay the wallet proven inside an attested score. They have been on devnet since Oct 13, where one 0.05 SOL bounty was paid under a test root. The first real enclave score (22/30, Intel TDX on Google Cloud) was proven and paid on a local chain.
- **Audit package:** [`audit/`](../audit/).

## Why it matters for the Solana ecosystem in India (our reading of public reports)
- **India's GPU clouds need financing.** India is building GPU clouds at national scale: the IndiaAI Mission subsidises GPU compute from empanelled providers, and Indian clouds are buying H100-class fleets. The operators carry the hardware cost up front. Credit against GPUs that a lender anywhere can check onchain is a way for them to borrow from global onchain lenders, not only from domestic banks.
- **The proof puts the credit check on Solana.** USDai, the dollar of the largest onchain GPU lender (USD.AI), is on Solana through Kamino. A covenant result is a public Solana account any curator can read, so an Indian operator's facility becomes legible to the same capital.
- **Students and developers can use it for free.** The verifiers (the NVIDIA H100 attestation verifier in a zkVM, the TDX quote verifier and the Groth16 verifier for Solana) are MIT licensed. Any Indian team building attested compute can reuse them.

## India-first pilot path
1. One Indian GPU operator runs the proof on its own H100, signed against a lender's challenge inside a confidential VM. This is the "own-enclave evidence" milestone.
2. A lender reads the result on devnet, then on mainnet after the audit.
3. The Superteam India community helps with the first operator and lender introductions, and with the first sealed-eval bounty, which is a model competition with hidden tests for Indian ML students.
