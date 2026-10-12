# One-shot devnet deploy + demo for Plumbline. Safe to re-run: each step skips what is already done.
# Run from PowerShell, in the repo:  powershell -ExecutionPolicy Bypass -File scripts\devnet-go.ps1 [-Branch <name>]
# Deploys oracle\dist\pct_oracle.so from the branch that is checked out, or from -Branch if given.
param([string]$Branch = "")
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
Start-Transcript -Path "$root\devnet-go.log" -Force | Out-Null
try {
  if (-not $Branch) { $Branch = (git rev-parse --abbrev-ref HEAD).Trim() }
  if ($Branch -eq "HEAD") {
    Write-Host "== 1/5 Detached checkout: deploying it as is"
  } else {
    Write-Host "== 1/5 Update the code (branch $Branch)"
    git fetch origin $Branch
    git checkout $Branch
    git merge --ff-only "origin/$Branch"
  }
  $sha = (Get-FileHash oracle\dist\pct_oracle.so -Algorithm SHA256).Hash.ToLower()
  Write-Host "deploying oracle\dist\pct_oracle.so sha256 $sha"
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

  Write-Host "== 3/5 Devnet SOL"
  $prog = "2jvEsAiBYWPeiSzb54qMgBbtbQivQkK5ZiTkp2bgZ6kz"
  $deployed = $false
  $curLen = 0
  try {
    $show = solana program show $prog 2>$null
    if ($LASTEXITCODE -eq 0) {
      $deployed = $true
      $m = [regex]::Match(($show -join "`n"), "Data Length:\s*(\d+)")
      if ($m.Success) { $curLen = [int64]$m.Groups[1].Value }
    }
  } catch {}
  # Rent-exempt minimum in SOL for an account of $bytes data bytes (3,480 lamports per byte-year, 2 years, 128-byte header).
  function RentSol([int64]$bytes) { (($bytes + 128) * 3480 * 2) / 1e9 }
  # Peak need follows the size of the binary being deployed: the upload buffer (size + 37 bytes, refunded after),
  # plus the program data account (size + 45) on a first deploy, or only its growth on an upgrade, plus fees.
  $size = (Get-Item oracle\dist\pct_oracle.so).Length
  $buffer = RentSol ($size + 37)
  $data = if ($deployed) { [math]::Max(0, (RentSol ($size + 45)) - (RentSol ($curLen + 45))) } else { RentSol ($size + 45) }
  $need = [math]::Round($buffer + $data + 0.2, 2)
  Write-Host ("binary {0:N0} bytes: deploy needs about {1} SOL at peak, {2:N2} SOL of it comes back" -f $size, $need, $buffer)
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
