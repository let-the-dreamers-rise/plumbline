# @pct/relayer

Pushes the Solana H100 paid index into a Hyperliquid HIP-3 perp oracle (the Day 2 gate and the
"Solana index -> HyperCore oracle" milestone). Needs Node 22.12+.

```bash
npm run hl:deploy                       # registers pct:H100 on a new "pct" dex (testnet)
npm run hl:relay                        # setOracle every 3s from the Solana book
DRY_RUN=true npm run hl:relay -- --once # prints the action, no Hyperliquid key needed
```

Policy: the relayer posts only a live index (3+ providers) cranked within `RELAY_MAX_AGE_S`
(default 1800s), and moves at most `RELAY_MAX_STEP_BPS` (default 100 = 1%) per update, so a price
shock walks in over several updates. When it holds, HIP-3 keeps the last oracle price.

| Variable | Default | Notes |
| --- | --- | --- |
| `HL_PRIVATE_KEY` | required (not for dry run) | Deployer / oracle updater key. Testnet only; never commit it. |
| `HL_TESTNET` | `true` | `hl:deploy` refuses mainnet unless passed `--mainnet`. |
| `HL_DEX`, `HL_COIN` | `pct`, `pct:H100` | HIP-3 asset names are prefixed with the dex name. |
| `HL_SZ_DECIMALS` | `2` | Prices keep 5 significant figures and at most 6 - szDecimals decimals. |
| `HL_MARGIN_TABLE_ID`, `HL_MARGIN_MODE` | `3`, `strictIsolated` | Check against the HIP-3 docs before deploying. |
| `HL_INITIAL_PX` | live index | Needed for `hl:deploy` when the index is not live yet (e.g. `2.71`). |
| `HL_MAX_GAS`, `HL_ORACLE_UPDATER` | auction price, deployer | Passed through to `registerAsset2`. |
| `SOLANA_RPC_URL`, `PCT_PROGRAM_ID` | devnet, `2jvEs…` | Where the oracle program lives. |

Unverified until run on testnet: whether registering a dex needs the 500k HYPE stake (the plan's
kill switch), the margin table id, and the exact `coin` format `registerAsset2` expects.
