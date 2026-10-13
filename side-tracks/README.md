# Colosseum Crypto World's Fair sidetracks

Plumbline's main entry is the lending covenant: GPU-backed credit released by proof (see the [repository README](../README.md)). This folder maps each Superteam Earn sidetrack we entered to what was built for it in this repository.

| Sidetrack | What the sponsor asks for | What is built here |
|---|---|---|
| CertiK security audit credits | A Solana project heading to mainnet that needs an audit | [`audit/`](../audit/): scope with measured line counts ([SCOPE.md](../audit/SCOPE.md)), invariants and our own findings ([THREAT-MODEL.md](../audit/THREAT-MODEL.md)), and one command that runs every test ([run-tests.sh](../audit/run-tests.sh)) |
| Adevar Labs pre-audit credits | A Solana/Rust codebase ready for a pre-audit | The same [`audit/`](../audit/) package. Its eight self-review findings (T-1 to T-8) are the starting list for the pre-audit. |
| Superteam India | An Indian team building on Solana, judged on ecosystem impact, product-market fit and growth | [superteam-india.md](superteam-india.md): why GPU-backed credit matters for India's GPU clouds, and the India-first pilot path |

## Not entered

- **Solami:** this needs a live mainnet demo running on Solami's data feed, a Solami account and API key. It was held for the founder's OK.
- **Panta:** this needs a Panta API key and a USDC fee to create a market, and a prediction market does not fit a lender product.
- **AkcaVPN:** these are VPN credits with nothing to build. It is optional and text only.

Nothing in this folder deploys anything. Every program is on devnet only.
