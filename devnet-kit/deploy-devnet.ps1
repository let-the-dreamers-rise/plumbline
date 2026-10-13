# Plumbline devnet deploy: registry + bounty programs, then the registry config.
# Devnet only. Safe to re-run: each step is skipped when it is already done, and an interrupted
# program upload resumes into the same buffer account (no SOL is paid twice).
#
#   powershell -ExecutionPolicy Bypass -File deploy-devnet.ps1
#   powershell -ExecutionPolicy Bypass -File deploy-devnet.ps1 -ComposeHash <64 hex>   # if you already know it
#
# Never uses a faucet or airdrop. Never prints secret keys.
param(
  [string]$Url = "https://api.devnet.solana.com",
  [string]$Keypair = "$env:USERPROFILE\.config\solana\id.json",
  [string]$ExpectedPayer = "DuW6RXbYi4HtSFUaU5AKQoNJQh1oAbQTzgsqJK5iVETc",
  [switch]$AnyPayer,
  [string]$Repo = "",
  [string]$ImageId = "0x68049079fafddc9192761eb4461fb8cb036e92275fb91aa7ef61801c975114c6",
  [string]$RootSha = "44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3",
  # Leave empty: the CLI stores a placeholder; set the real one later with registry set-config.
  [string]$ComposeHash = "",
  [int]$ComputeUnitPrice = 2000,
  [int]$Attempts = 4
)
$ErrorActionPreference = "Stop"
$Kit = $PSScriptRoot
$RegistryId = "Eicw3HXxXN7kckn5XB4WDGQG2c61BLf7X7QpGehLTgAW"
$BountyId = "9mDieYQNR2L9xgaqS6LK26kxR26rA4R9UcFntG369RPf"
Start-Transcript -Path "$Kit\deploy-devnet.log" -Force | Out-Null
$Npx = if (Get-Command npx.cmd -ErrorAction SilentlyContinue) { "npx.cmd" } else { "npx" }
$results = [ordered]@{ cluster = "devnet"; registry = $RegistryId; bounty = $BountyId }

function Explorer($kind, $id) { "https://explorer.solana.com/$kind/$id`?cluster=devnet" }
function Fail($msg) { Write-Host ""; Write-Host "STOPPED: $msg" -ForegroundColor Red; exit 1 }  # the finally block stops the transcript
# Run a native command without PowerShell turning its stderr into an exception; returns stdout lines.
function Native([scriptblock]$cmd) {
  $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { $o = & $cmd } finally { $ErrorActionPreference = $old }
  return $o
}
# Rent-exempt minimum in lamports for $bytes data bytes (what `solana rent` reports).
function RentLamports([int64]$bytes) { ($bytes + 128) * 6960 }
function Sol([int64]$l) { "{0:N4} SOL" -f ($l / 1e9) }
function Balance() { [int64]((Native { solana balance --lamports -u $Url -k $Keypair }) -split " ")[0] }

try {
  if ($Url -match "mainnet") { Fail "this kit is devnet only" }

  Write-Host "== 1/6 Find the code and the kit"
  $candidates = @()
  if ($Repo) { $candidates += (Join-Path $Repo "plumbline\cli") }
  $candidates += (Join-Path $Kit "..\plumbline\cli"), (Join-Path $Kit "..\paid-compute-tape\plumbline\cli")
  $Cli = $candidates | Where-Object { Test-Path (Join-Path $_ "src\main.ts") } | Select-Object -First 1
  if (-not $Cli) { Fail "cannot find plumbline\cli. Put this folder in (or next to) the repo checkout, or pass -Repo <path to repo>" }
  $Cli = (Resolve-Path $Cli).Path
  if (-not (Test-Path (Join-Path $Cli "node_modules"))) { Fail "run 'npm ci' in $Cli first" }
  Write-Host "cli: $Cli"
  $sums = Get-Content "$Kit\programs\SHA256SUMS" | ForEach-Object { $p = $_ -split "\s+"; @{ sha = $p[0]; file = $p[1] } }
  foreach ($s in $sums) {
    $h = (Get-FileHash "$Kit\programs\$($s.file)" -Algorithm SHA256).Hash.ToLower()
    if ($h -ne $s.sha) { Fail "$($s.file) sha256 is $h, expected $($s.sha) (re-copy the kit)" }
    Write-Host "ok  $($s.file)  $h"
  }
  foreach ($k in @(@("registry", $RegistryId), @("bounty", $BountyId))) {
    $pk = (Native { solana-keygen pubkey "$Kit\keys\plumbline_$($k[0])-keypair.json" }) | Select-Object -Last 1
    if ($pk -ne $k[1]) { Fail "keys\plumbline_$($k[0])-keypair.json is $pk, expected $($k[1])" }
  }

  Write-Host "== 2/6 Wallet and balance"
  Native { solana --version } | Write-Host
  if (-not (Test-Path $Keypair)) { Fail "no wallet at $Keypair (pass -Keypair <file>)" }
  $me = ((Native { solana address -k $Keypair }) | Select-Object -Last 1).Trim()
  Write-Host "payer (upgrade authority and registry admin): $me"
  if (-not $AnyPayer -and $me -ne $ExpectedPayer) { Fail "wallet is $me, expected $ExpectedPayer (pass -AnyPayer to use this one)" }
  $genesis = ((Native { solana genesis-hash -u $Url }) | Select-Object -Last 1).Trim()
  if ($genesis -ne "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") { Fail "$Url reports genesis $genesis, which is not devnet; refusing" }
  Write-Host "rpc: $Url (genesis $genesis)"

  $deployed = @{}
  foreach ($n in @("registry", "bounty")) {
    $id = if ($n -eq "registry") { $RegistryId } else { $BountyId }
    $show = Native { solana program show $id -u $Url --output json 2>$null }
    $deployed[$n] = ($LASTEXITCODE -eq 0 -and ($show -join "") -match "programdataAddress")
  }
  # Peak need: the upload buffer and the program data account both exist during a deploy; the buffer's
  # rent comes back when it finishes. Deploy order is registry then bounty.
  $regLen = (Get-Item "$Kit\programs\plumbline_registry.so").Length
  $bouLen = (Get-Item "$Kit\programs\plumbline_bounty.so").Length
  $regData = RentLamports ($regLen + 45); $regBuf = RentLamports ($regLen + 37)
  $bouData = RentLamports ($bouLen + 45); $bouBuf = RentLamports ($bouLen + 37)
  $fees = 20000000  # 0.02 SOL: ~620 upload transactions, priority fee, retries, config
  $peak = 0
  if (-not $deployed["registry"]) { $peak = $regData + $regBuf }
  $afterReg = if ($deployed["registry"]) { 0 } else { $regData }
  if (-not $deployed["bounty"]) { $peak = [math]::Max($peak, $afterReg + $bouData + $bouBuf) }
  $need = $peak + $fees
  $bal = Balance
  Write-Host ("registry {0:N0} bytes, bounty {1:N0} bytes; deployed already: registry={2} bounty={3}" -f $regLen, $bouLen, $deployed["registry"], $deployed["bounty"])
  $kept = $afterReg; if (-not $deployed["bounty"]) { $kept += $bouData }
  Write-Host "balance $(Sol $bal); this run needs about $(Sol $need) at its peak and keeps $(Sol $kept) of it as program rent"
  if ($bal -lt $need) {
    $short = $need - $bal
    Write-Host "Short by $(Sol $short)." -ForegroundColor Yellow
    Write-Host "Check for leftover upload buffers from an earlier attempt (their rent is yours):"
    Write-Host "  solana program show --buffers -u $Url -k `"$Keypair`""
    Write-Host "  solana program close --buffers -u $Url -k `"$Keypair`""
    Write-Host "or move devnet SOL in from another devnet wallet you control. This script never uses a faucet."
    Fail "not enough SOL"
  }

  # Deploy one program, resuming into a fixed buffer keypair on retry. Attempt 1 sends the upload the
  # default way; later attempts use --use-rpc (helps behind home routers where TPU/QUIC sends drop).
  function Deploy($name, $id, $len) {
    $so = "$Kit\programs\plumbline_$name.so"
    $buf = "$Kit\buffer-$name.json"
    if (-not (Test-Path $buf)) { Native { solana-keygen new --no-bip39-passphrase --silent --outfile $buf } | Out-Null }
    $bufAddr = ((Native { solana-keygen pubkey $buf }) | Select-Object -Last 1).Trim()
    Write-Host "upload buffer for $name`: $bufAddr (keypair $buf; kept for resume)"
    for ($i = 1; $i -le $Attempts; $i++) {
      $extra = @(); if ($i -gt 1) { $extra += "--use-rpc" }
      Write-Host "deploy $name, attempt $i/$Attempts $($extra -join ' ')"
      $out = Native { solana program deploy $so --program-id "$Kit\keys\plumbline_$name-keypair.json" --buffer $buf `
        --max-len $len --with-compute-unit-price $ComputeUnitPrice --max-sign-attempts 50 -u $Url -k $Keypair --output json @extra }
      $code = $LASTEXITCODE
      $text = ($out -join "`n")
      if ($code -eq 0 -and $text -match '"signature"\s*:\s*"([1-9A-HJ-NP-Za-km-z]+)"') {
        Remove-Item $buf -ErrorAction SilentlyContinue  # buffer was consumed by the deploy
        return $Matches[1]
      }
      Write-Host $text
      Write-Host "attempt $i failed (devnet RPC is often flaky: blockhash expired, 429, dropped writes). Waiting 20 s, then resuming into the same buffer." -ForegroundColor Yellow
      Start-Sleep -Seconds 20
    }
    Write-Host "Still failing. Nothing is lost: the partial upload is in buffer $bufAddr and its rent is yours."
    Write-Host "  - run this script again later (it resumes into the same buffer), or try -Url with another devnet RPC"
    Write-Host "  - to give up and get the buffer rent back: solana program close $bufAddr -u $Url -k `"$Keypair`""
    Fail "deploy of $name did not finish"
  }

  Write-Host "== 3/6 Deploy registry ($RegistryId)"
  if ($deployed["registry"]) { Write-Host "already deployed, skipping" }
  else { $sig = Deploy "registry" $RegistryId $regLen; $results.registryDeployTx = $sig; Write-Host "deploy tx $sig"; Write-Host (Explorer "tx" $sig) }
  Write-Host "balance $(Sol (Balance))"

  Write-Host "== 4/6 Deploy bounty ($BountyId)"
  if ($deployed["bounty"]) { Write-Host "already deployed, skipping" }
  else { $sig = Deploy "bounty" $BountyId $bouLen; $results.bountyDeployTx = $sig; Write-Host "deploy tx $sig"; Write-Host (Explorer "tx" $sig) }
  Write-Host "balance $(Sol (Balance))"

  foreach ($id in @($RegistryId, $BountyId)) {
    $j = (Native { solana program show $id -u $Url --output json }) -join "" | ConvertFrom-Json
    if ($j.authority -ne $me) { Fail "program $id upgrade authority is $($j.authority), not $me" }
    Write-Host "ok  $id  data $($j.dataLen) bytes, authority $($j.authority)"
  }

  Write-Host "== 5/6 Registry config (image id, Intel root, compose hash)"
  Push-Location $Cli
  try {
    $pl = @("tsx", "src/main.ts", "--cluster", $Url, "--keypair", $Keypair)
    $raw = (Native { & $Npx @pl --json registry show-config }) -join "`n"
    if ($LASTEXITCODE -ne 0 -or -not $raw) { Fail "plumbline registry show-config failed (see the error above); re-run this script to retry" }
    $cur = $raw | ConvertFrom-Json
    if ($cur.config) {
      Write-Host "config already initialised, skipping init-config:"
      Native { & $Npx @pl registry show-config } | Write-Host
    } else {
      $args2 = @("registry", "init-config", "--image-id", $ImageId, "--root-sha", $RootSha)
      if ($ComposeHash) { $args2 += @("--compose-hash", $ComposeHash) }
      $init = (Native { & $Npx @pl --json @args2 }) -join "`n"
      if ($LASTEXITCODE -ne 0) { Fail "registry init-config failed (see the error above); re-run this script to retry" }
      $r = $init | ConvertFrom-Json
      $results.initConfigTx = $r.signature
      Write-Host "init-config tx $($r.signature)"
      Write-Host (Explorer "tx" $r.signature)
      Native { & $Npx @pl registry show-config } | Write-Host
    }
  } finally { Pop-Location }

  Write-Host "== 6/6 Done"
  $results.payer = $me
  $results.balanceAfter = Sol (Balance)
  Write-Host ""
  Write-Host "registry program  $RegistryId"
  Write-Host "                  $(Explorer 'address' $RegistryId)"
  Write-Host "bounty program    $BountyId"
  Write-Host "                  $(Explorer 'address' $BountyId)"
  foreach ($k in @("registryDeployTx", "bountyDeployTx", "initConfigTx")) { if ($results[$k]) { Write-Host ("{0,-17} {1}" -f $k, (Explorer "tx" $results[$k])) } }
  Write-Host "balance left      $($results.balanceAfter)"
  $results | ConvertTo-Json | Set-Content "$Kit\deploy-devnet-result.json"
  Write-Host ""
  Write-Host "Paste the block above (or deploy-devnet-result.json) into the thread."
} finally {
  Stop-Transcript | Out-Null
}
