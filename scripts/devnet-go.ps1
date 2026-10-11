# One-shot devnet deploy + demo for Ironproof. Safe to re-run: each step skips what is already done.
# Run from PowerShell, in the repo:  powershell -ExecutionPolicy Bypass -File scripts\devnet-go.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
Start-Transcript -Path "$root\devnet-go.log" -Force | Out-Null
try {
  Write-Host "== 1/5 Update the code (branch claude/oracle-cloud-build)"
  git fetch origin claude/oracle-cloud-build
  git checkout claude/oracle-cloud-build
  git merge --ff-only origin/claude/oracle-cloud-build
  npm install --no-audit --no-fund | Out-Null

  Write-Host "== 2/5 Solana CLI"
  $sol = Get-Command solana -ErrorAction SilentlyContinue
  if (-not $sol) {
    $bin = "$env:USERPROFILE\.local\share\solana\install\active_release\bin"
    if (-not (Test-Path "$bin\solana.exe")) {
      New-Item -ItemType Directory -Force C:\solana-install-tmp | Out-Null
      # Versioned Windows installers 404 on release.anza.xyz; the stable channel works.
      curl.exe -sSfL https://release.anza.xyz/stable/solana-install-init-x86_64-pc-windows-msvc.exe -o C:\solana-install-tmp\solana-install-init.exe
      C:\solana-install-tmp\solana-install-init.exe stable
    }
    $env:PATH = "$bin;$env:PATH"
  }
  solana --version
  solana config set --url https://api.devnet.solana.com | Out-Null
  $id = "$env:USERPROFILE\.config\solana\id.json"
  if (-not (Test-Path $id)) { solana-keygen new --no-bip39-passphrase --silent --outfile $id | Out-Null }
  $me = solana address
  Write-Host "payer: $me"

  Write-Host "== 3/5 Devnet SOL (deploy needs about 7.5 SOL at peak, about half comes back)"
  $prog = "2jvEsAiBYWPeiSzb54qMgBbtbQivQkK5ZiTkp2bgZ6kz"
  $deployed = $false
  try { solana program show $prog 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $deployed = $true } } catch {}
  $need = if ($deployed) { 0.6 } else { 8 }
  for ($i = 0; $i -lt 6; $i++) {
    $bal = [double]((solana balance) -split " ")[0]
    if ($bal -ge $need) { break }
    try { solana airdrop 2 | Out-Null } catch { Write-Host "airdrop refused (rate limit)" }
    Start-Sleep -Seconds 15
  }
  $bal = [double]((solana balance) -split " ")[0]
  Write-Host "balance: $bal SOL"
  if ($bal -lt $need) {
    Write-Host "NEED SOL: get devnet SOL for $me at https://faucet.solana.com (sign in with GitHub), then run this script again."
    exit 2
  }

  Write-Host "== 4/5 Deploy the program"
  if ($deployed) { Write-Host "already deployed; upgrading to this build" }
  solana program deploy oracle\dist\pct_oracle.so --program-id oracle\target\deploy\pct_oracle-keypair.json --with-compute-unit-price 10000
  solana program show $prog

  Write-Host "== 5/5 Demo: proofs, allowed draw, refused draw, replay"
  $env:SOLANA_RPC_URL = "https://api.devnet.solana.com"
  $env:SOLANA_KEYPAIR = $id
  npx tsx scripts/zk-devnet-demo.ts
  Write-Host "DONE: results in zk-devnet-demo.json"
} finally {
  Stop-Transcript | Out-Null
}
