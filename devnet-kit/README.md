# Plumbline devnet kit

This kit puts the two Plumbline programs (the **registry**, which records verified scores, and the **bounty** escrow, which pays them) on Solana **devnet** from your Windows laptop. The cloud container can't reach devnet, so the deploy has to run on the laptop.

It's devnet only. Both scripts refuse any RPC that isn't devnet, and they never use a faucet or airdrop. They never print secret keys.

## What's in the folder

| File | What it is |
|---|---|
| `programs/plumbline_registry.so` | Registry program, 372,640 bytes, sha256 `291878771ace415059a596382d700642b34f0cbee31fa0780c2916e0f39336f9` |
| `programs/plumbline_bounty.so` | Bounty program, 249,240 bytes, sha256 `304be748272dd3bcd68a5381ef7f60e17bc88d5528239099e3cd4169697e5223` |
| `programs/SHA256SUMS` | The two hashes above. The deploy script checks them before it sends anything. |
| `keys/plumbline_registry-keypair.json` | Program keypair. Its public key is `Eicw3HXxXN7kckn5XB4WDGQG2c61BLf7X7QpGehLTgAW`. |
| `keys/plumbline_bounty-keypair.json` | Program keypair. Its public key is `9mDieYQNR2L9xgaqS6LK26kxR26rA4R9UcFntG369RPf`. |

**Deployed on devnet on 2026-10-13, so the two program keypairs are spent and were removed from the repo.** They only fixed the program addresses; the upgrade authority is the deployer wallet, which was never in the repo. Re-running the deploy needs the original `keys\` folder from `devnet-kit.zip`.
| `deploy-devnet.ps1` | Deploys both programs and sets up the registry config. Run this now. |
| `devnet-demo.ps1` | Runs suite register, then bounty create, then record proof, then claim. Run this later, once a real proof exists. |
| `budget-localnet.txt` | A rehearsal of the same sequence on a private local validator, with exactly 6.48 SOL. |

**About the two program keypairs.** They only fix the program addresses. The bounty program has the registry's address built in, and the CLI and web app expect both addresses, so the programs must be deployed at exactly these ids.

- They hold no money.
- They give no control. Your wallet becomes the upgrade authority and the registry admin.
- After the first deploy they can't do anything more.
- They're still secret-key files, so don't publish them.

## What it costs (wallet `DuW6RXbYi4HtSFUaU5AKQoNJQh1oAbQTzgsqJK5iVETc`, about 6.48 SOL)

These numbers come from the localnet rehearsal (`budget-localnet.txt`). Fees on devnet will be slightly higher.

| Step | SOL spent | Left (from 6.48) |
|---|---|---|
| Deploy registry (`--max-len 372640`) | 2.5979 | 3.8821 |
| Deploy bounty (`--max-len 249240`) | 1.7384 | 2.1437 |
| `registry init-config` | 0.0022 | 2.1416 |
| `suite register` (demo) | 0.0018 | 2.1398 |
| `bounty create` 0.05 SOL (demo) | 0.0532 | 2.0866 |
| `record` proof (demo) | 0.0036 | about 2.083 |
| `claim` (demo) | 0.000005 | about 2.083 |

Most of the cost is program rent: 2.5948 SOL for the registry and 1.7359 SOL for the bounty. That rent stays locked while the programs exist.

During each deploy the CLI also holds an upload buffer of about the same size. The buffer's rent comes back as soon as the deploy finishes. The tightest moment is the bounty upload, which needs about 6.07 SOL in hand. That leaves about 0.41 SOL of headroom on 6.48 SOL. The script works out this number and stops before sending anything if your balance is too low.

## Before you start (one time)

You need the Solana CLI (the one that deployed the oracle) and Node 20 or newer.

```powershell
cd C:\path\to\paid-compute-tape          # your existing clone
git fetch origin claude/plumbline-product
git checkout claude/plumbline-product
git merge --ff-only origin/claude/plumbline-product
cd plumbline\cli
npm ci
cd ..\..
```

Copy this whole `devnet-kit` folder into the repo root, so that you have `paid-compute-tape\devnet-kit\deploy-devnet.ps1` next to `paid-compute-tape\plumbline\`. Putting it beside the `paid-compute-tape` folder also works. Anywhere else, pass `-Repo C:\path\to\paid-compute-tape`. Don't commit the folder: it holds keypairs.

The scripts run the CLI as `npx tsx src/main.ts` from `plumbline\cli` (`bin/plumbline` is a bash script and won't run on Windows). The wallet defaults to `%USERPROFILE%\.config\solana\id.json`. Pass `-Keypair <file>` if yours is somewhere else.

## Step 1: deploy (now)

```powershell
cd C:\path\to\paid-compute-tape\devnet-kit
powershell -ExecutionPolicy Bypass -File deploy-devnet.ps1
```

The script runs these steps in order. Each step that is already done is skipped, so it's safe to run again.

1. **Find the code and the kit.** It checks both `.so` hashes and both program ids. You should see:
   ```
   ok  plumbline_bounty.so  304be748...
   ok  plumbline_registry.so  29187877...
   ```
2. **Wallet and balance.** It prints `payer ... DuW6RXbY...` and stops if the wallet is a different one (`-AnyPayer` overrides this). It checks that the RPC really is devnet (genesis `EtWTRABZ...`) and prints `balance 6.4800 SOL; this run needs about 6.0866 SOL at its peak ...`.
3. **Deploy registry.** This is `solana program deploy --program-id keys\plumbline_registry-keypair.json --buffer buffer-registry.json --max-len 372640 --with-compute-unit-price 2000 --max-sign-attempts 50`. The upload takes about 370 transactions, a few minutes on devnet. It ends with `deploy tx <signature>` and an explorer link.
4. **Deploy bounty.** The same as step 3 for the bounty program, about 250 transactions.
   - After both deploys it checks that each program's upgrade authority is your wallet: `ok  Eicw3... data 372640 bytes, authority DuW6...`
5. **Registry config.** It runs `registry init-config --image-id 0x68049079...14c6 --root-sha 44a0196b...74d3`.
   - That is the production guest image and the sha256 of Intel's SGX Root CA.
   - The enclave **compose hash** isn't known yet, so a placeholder `ffff...ff` is stored. The program won't accept zero. While the placeholder is in place, no score can be recorded. That is intended.
   - If you already know the compose hash, add `-ComposeHash <64 hex>`.
6. **Done.** It prints the block to send back:
   ```
   registry program  Eicw3HXxXN7kckn5XB4WDGQG2c61BLf7X7QpGehLTgAW
                     https://explorer.solana.com/address/Eicw3...?cluster=devnet
   bounty program    9mDieYQNR2L9xgaqS6LK26kxR26rA4R9UcFntG369RPf
                     https://explorer.solana.com/address/9mDie...?cluster=devnet
   registryDeployTx  https://explorer.solana.com/tx/...?cluster=devnet
   bountyDeployTx    https://explorer.solana.com/tx/...?cluster=devnet
   initConfigTx      https://explorer.solana.com/tx/...?cluster=devnet
   balance left      2.14.. SOL
   ```
   The same values go into `deploy-devnet-result.json`, and the full log into `deploy-devnet.log`.

**If devnet is flaky** (blockhash expired, 429 Too Many Requests, "N write transactions failed"):

- The script retries each deploy up to 4 times, 20 seconds apart. From the second try on it adds `--use-rpc`, which helps on home networks.
- Every retry reuses the same upload buffer (`buffer-registry.json` or `buffer-bounty.json` in this folder), so nothing is paid twice.
- If it still stops, run it again later. It continues where it left off. You can also point it at another devnet RPC with `-Url https://<your-devnet-rpc>`. The URL host must contain "devnet".
- To give up on a half-done upload and get its rent back:
  ```powershell
  solana program show --buffers -u devnet
  solana program close --buffers -u devnet
  ```

**If it says you're short of SOL:** it prints exactly how much is missing. Close any leftover buffers with the commands above, or move devnet SOL in from another devnet wallet you control. Don't use a faucet. With 6.48 SOL nothing should be short: about 0.41 SOL is spare at the tightest point.

**Setting the compose hash later** (once the Phala enclave's compose hash is known). Only the deploying wallet can do this.

```powershell
cd C:\path\to\paid-compute-tape\plumbline\cli
npx tsx src/main.ts --cluster devnet registry set-config --compose-hash <64 hex>
npx tsx src/main.ts --cluster devnet registry show-config
```

The demo script can also do this for you from the proof (`-SetCompose`, see below).

## Step 2: demo (later, once a real proof exists)

The input is a Groth16 proof JSON from `plumbline/zk` (`{imageId, journal, seal}`), made by the **production** guest. That proof states the score and the payout address.

```powershell
cd C:\path\to\paid-compute-tape\devnet-kit
powershell -ExecutionPolicy Bypass -File devnet-demo.ps1 -Proof C:\path\to\proof.json -SetCompose
```

1. **Proof check.** It runs `proof inspect --check-config` and prints the statement, suite, score, payout, image and compose. Then it says whether the registry would accept the proof. With `-SetCompose`, a placeholder or mismatched compose hash is set to the proof's own value with `registry set-config`.
   - A proof from the TEST ONLY guest (different image and root) is refused here, before any SOL is spent.
2. **`suite register <suite from the proof>`.** If an earlier run already registered the suite, it says so and continues.
3. **`bounty create`.** It escrows 0.05 SOL with the target equal to the proof's own score, a deadline about a day out, and `--require-registered-suite`. It prints the bounty address. Change the amount with `-Reward`, the target with `-Target 2/3`, and the deadline with `-DeadlineSlots`.
4. **`record <proof.json>`.** The registry checks the Groth16 proof onchain and writes the VerifiedScore. It prints the score address.
5. **`claim`.** The 0.05 SOL goes to the payout address inside the proof. Whoever sends the claim can't change where the money goes.

The order matters. The bounty must exist before the score is recorded, because a score older than the bounty can't claim it (`ScoreBeforeBounty`). If `record` says "already in use", that proof was recorded earlier. In that case:

- that proof can't claim the new bounty, and a fresh proof is needed;
- the bounty can be refunded after its deadline plus grace with `plumbline bounty refund <bounty>`.

At the end it prints:

```
== Signatures to paste into the thread
setConfigTx      https://explorer.solana.com/tx/...?cluster=devnet
suiteRegisterTx  https://explorer.solana.com/tx/...?cluster=devnet
bountyCreateTx   https://explorer.solana.com/tx/...?cluster=devnet
recordTx         https://explorer.solana.com/tx/...?cluster=devnet
claimTx          https://explorer.solana.com/tx/...?cluster=devnet
bounty           https://explorer.solana.com/address/...?cluster=devnet
verifiedScore    https://explorer.solana.com/address/...?cluster=devnet
```

It also saves them to `devnet-demo-result.json`, and the full log to `devnet-demo.log`.

## Sending the results back

Copy the final block that each script prints and paste it into the Plumbline thread as a message. If the window has closed, paste the contents of `deploy-devnet-result.json` or `devnet-demo-result.json` instead.

These files hold only public data: addresses, signatures and links. Never paste anything from `keys\`, `buffer-*.json` or your `id.json`. If a script stopped with an error, paste the last 30 lines of `deploy-devnet.log` or `devnet-demo.log`.

## Rehearsed in the container

`plumbline/cli/scripts/devnet-budget.sh` runs the same sequence on a private local test validator:

- a throwaway payer funded with exactly 6.48 SOL;
- both deploys with `--max-len` equal to each `.so` size;
- init-config, suite register, a 0.05 SOL bounty;
- then the demo half with the TEST ONLY payout fixture: set-config, register, bounty, record and claim, with 0.05 SOL reaching the proven payout.

It ended with 2.028 SOL left. The output is in `budget-localnet.txt`.

The PowerShell scripts themselves were not run, because the container has no PowerShell. The CLI commands they call were run as written.
