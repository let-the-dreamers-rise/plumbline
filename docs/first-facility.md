# First facility: what a weekly proof would add to USD.AI's public loan book

This page maps every funded position in USD.AI's public loan book to what a weekly Plumbline proof
would add, and to what is still missing for it. The data was read on Oct 12, 2026 from USD.AI's own
API. Plumbline is not affiliated with USD.AI, and nothing here was sent to them. Borrower names are
left out; positions are identified by the API's own ids. Lines marked *[inf]* are our inference.

## The honest gap first

**92% of the funded book is Blackwell** (B200, B300, DGX B300 and RTX PRO 6000 GPUs). Plumbline's GPU
check has only been run on NVIDIA's published sample **H100** report. The two H200 positions, about 8%
of the book, are Hopper, the same family as the tested H100 path. Even those have not been run with a
real H200 report signed against a lender's challenge *[inf]*. Every Blackwell row below is therefore
blocked on an attestation path that has not been tested.

## Summary

- **20 funded positions, $177.3M principal outstanding**, about $1.62M of debt service a week, with
  558 servers and 4,536 GPUs listed (sum of `remainingAmount` in `proof-of-reserves`).
- USD.AI publishes the covenant a proof would test: "Loans are monitored quarterly against a minimum
  1.15x debt service coverage ratio (DSCR)", tested against trailing cash receipts
  ([underwriting page](https://usd.ai/insights/usdai-underwriting-and-risk-management)). Plumbline runs
  the same kind of test weekly, with the ratio set as a loan term.
- Public telemetry lists servers and GPU counts. It shows neither chip identity nor revenue.
- **Best first fit: the H200 [75] position in Missouri** (`26472cfd`, $14.08M outstanding, about $141k
  of debt service a week). A low-stakes alternative is the H200 [4] position in Montréal (`6598ba4c`,
  $0.42M).

## Funded positions

Sorted by principal outstanding.
- **Weekly debt service** is our estimate: next month's scheduled principal, plus interest on the
  remaining balance (outstanding × APR ÷ 12), times 12/52. It is within about 3% of the next scheduled
  payment where checked *[inf]*.
- **4-week revenue at 1.15x** is what a 4-week proof window must show to PASS at USD.AI's published
  minimum. Multiply it by 3.25 for a 13-week window.
- **Telemetry** is servers / GPUs / healthy, as returned by `api.usd.ai/loans/{id}/hardware`.

| # | API id · collateral · location | Outstanding · APR | Weekly debt service · 4-wk revenue at 1.15x | Telemetry | GPU path status |
|---|---|---|---|---|---|
| 1 | `15643b8e` · B300 [130] · OH, USA | $54.40M · 10.0% | $453k · $2.09M | 130 / 1,040 / 130 | Blackwell, untested |
| 2 | `37fddd85` · B200 [96] · Sweden | $31.22M · 12.0% | $290k · $1.34M | 96 / 768 / 96 | Blackwell, untested |
| 3 | `9405f9b0` · B300 [72] · WA, USA | $22.35M · 10.0% | $215k · $988k | 72 / 562 / 72 | Blackwell, untested |
| 4 | `2682e26c` · B300 [34] · PA, USA | $14.91M · 15.0% | $139k · $638k | 34 / 272 / 34 | Blackwell, untested |
| 5 | `26472cfd` · **H200 [75]** · MO, USA | $14.08M · 12.0% | $141k · $647k | 75 / 598 / 75 | **Hopper: closest to the tested path** |
| 6 | `8d33be24` · B200 [32] · TX, USA | $10.22M · 11.5% | $96k · $443k | 32 / 256 / 32 | Blackwell, untested |
| 7 | `d3ddb565` · DGX B300 [24] · NE, USA | $9.56M · 15.0% | $89k · $409k | none listed | Blackwell, untested |
| 8 | `417cc4b8` · B200 [32] · DE, USA | $7.32M · 10.0% | $62k · $286k | 32 / 344 / 32 | Blackwell, untested |
| 9 | `16d5ab14` · B200 [38] · TX, USA | $7.13M · 11.5% | $72k · $331k | 38 / 304 / 38 | Blackwell, untested |
| 10 | `2bfd491d` · B300 [9] / RTX PRO 6000 [18] · PA, USA | $3.44M · 12.0% | $36k · $167k | 27 / 216 / 27 | Blackwell; RTX PRO 6000 attestation unconfirmed |
| 11 | `11ac9b68` · B200 [8] · France | $1.66M · 15.0% | $20k · $90k | 8 / 64 / 8 | Blackwell, untested |
| 12 | `6598ba4c` · **H200 [4]** · Montréal | $0.42M · 12.0% | $5k · $24k | 4 / 32 / 4 | **Hopper: closest to the tested path** |
| 13 | 7 positions (`e8b74f1a`, `7681d15b`, `426919e9`, `39784b8e`, `08143a90`, `90e3ca49`, `21092778`) · RTX PRO 6000 [1] each · Montréal | $0.43M together · 13.5% | $4.6k · $21k together | 1 / 8 / 1 each | RTX PRO 6000 attestation unconfirmed |
| 14 | `10051edf` · RTX PRO 6000 [3] · TX, USA | $0.16M · 15.0% | $1.7k · $8k | 3 / 24 / 3 | RTX PRO 6000 attestation unconfirmed |
| | **Total** | **$177.30M** | **≈ $1.62M a week** | **558 / 4,536 / all healthy** | |

**Counts a curator may want explained.** These are differences between public sources, not findings
of fault:
- Row 3: 562 GPUs reported, against 576 in the July attestation report.
- Row 5: 598 GPUs reported, against 600.
- Row 8: 344 GPUs reported on 32 servers, more than the 256 that 8 GPUs per server would give *[inf]*.
- Row 7: no hardware listed yet.

A proof records one NVIDIA-signed chip id per GPU that answers the lender's challenge. A GPU that
doesn't answer can't be counted.

## What the first facility needs, and what is built

| Needed for row 5 | Status |
|---|---|
| GPU attestation verified to NVIDIA's root (P-384) | Built; run only on NVIDIA's sample H100 report. No validity-date, revocation or RIM checks yet |
| The borrower's own GPU report and TDX quote, signed against the lender's challenge | Not built (host mode) |
| Enclave binding (Intel TDX quote) | Structural checks built; off in the demo (`vm_bound = 0`) |
| Revenue from USD.AI's covenant source (offtake receipts) | Not built; the demo uses Razorpay-shaped payouts signed by test attestor keys |
| Covenant test and draw gate (PASS at 1.15x, WATCH and refusal at 1.14x, replay refused) | Built; runs on a local validator with the shipped binary ([`demo/`](../demo/)) |
| One GPU per loan across lenders (device registry) | Built in source, off by default; not in the prebuilt binary |
| Every GPU in the facility, not one per proof | Planned: each GPU proven once against a lender-held chip list, then a weekly sample |
| Devnet or mainnet deployment, audit | Not done |

**What a proof cannot show, whatever is built:** title and off-chain liens (USD.AI's SPV and Loan NFT
cover that), GPU location and health (telemetry covers that), revenue outside the pinned source, and
self-dealing through a related-party offtaker *[inf]*.

## Sources

All read on Oct 12, 2026.
- USD.AI API, positions, amounts, APR and location: https://api.usd.ai/usdai/dashboard/proof-of-reserves?chainId=42161
- USD.AI API, hardware per loan: `https://api.usd.ai/loans/{id}/hardware`
- USD.AI API, repayment schedule: `https://api.usd.ai/usdai/loans/42161/{id}/schedule`
- The Network Firm agreed-upon-procedures report as of Jul 15, 2026: https://docs.usd.ai/usdai/proof-of-loans
- USD.AI, "Underwriting and Risk Management": https://usd.ai/insights/usdai-underwriting-and-risk-management
