# Plumbline devnet demo, run AFTER deploy-devnet.ps1 and once a real Groth16 proof exists
# (proof JSON from plumbline/zk, with the payout in its journal):
#   suite register -> bounty create (0.05 SOL) -> record <proof.json> -> claim
#
#   powershell -ExecutionPolicy Bypass -File devnet-demo.ps1 -Proof C:\path\to\proof.json
#   powershell -ExecutionPolicy Bypass -File devnet-demo.ps1 -Proof C:\path\to\proof.json -SetCompose
#
# Order matters: the bounty must exist before the score is recorded (the escrow refuses a score that is
# older than the bounty: ScoreBeforeBounty). Devnet only. Never uses a faucet. Never prints secret keys.
param(
  [Parameter(Mandatory = $true)][string]$Proof,
  [string]$Reward = "0.05",
  [string]$Target = "",            # default: exactly the proof's own score, e.g. 4/6
  [int64]$DeadlineSlots = 216000,  # about a day
  [switch]$SetCompose,             # if the config still has the placeholder (or another) compose hash, set it to the proof's
  [switch]$AdoptProofConfig,       # set image id, root and compose to the proof's (needed for the TEST-ROOT demo proof; switch back for a real score)
  [string]$Url = "https://api.devnet.solana.com",
  [string]$Keypair = "$env:USERPROFILE\.config\solana\id.json",
  [string]$Repo = ""
)
$ErrorActionPreference = "Stop"
$Kit = $PSScriptRoot
$Npx = if (Get-Command npx.cmd -ErrorAction SilentlyContinue) { "npx.cmd" } else { "npx" }
Start-Transcript -Path "$Kit\devnet-demo.log" -Force | Out-Null
$results = [ordered]@{ cluster = "devnet" }

function Explorer($kind, $id) { "https://explorer.solana.com/$kind/$id`?cluster=devnet" }
function Fail($msg) { Write-Host ""; Write-Host "STOPPED: $msg" -ForegroundColor Red; exit 1 }  # finally stops the transcript
function Native([scriptblock]$cmd) {
  $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { $o = & $cmd } finally { $ErrorActionPreference = $old }
  return $o
}
function Balance() { "{0:N4} SOL" -f ([int64]((Native { solana balance --lamports -u $Url -k $Keypair }) -split " ")[0] / 1e9) }

try {
  if ($Url -match "mainnet") { Fail "this kit is devnet only" }
  $candidates = @()
  if ($Repo) { $candidates += (Join-Path $Repo "plumbline\cli") }
  $candidates += (Join-Path $Kit "..\plumbline\cli"), (Join-Path $Kit "..\paid-compute-tape\plumbline\cli")
  $Cli = $candidates | Where-Object { Test-Path (Join-Path $_ "src\main.ts") } | Select-Object -First 1
  if (-not $Cli) { Fail "cannot find plumbline\cli. Put this folder in (or next to) the repo checkout, or pass -Repo <path to repo>" }
  $Cli = (Resolve-Path $Cli).Path
  if (-not (Test-Path $Proof)) { Fail "no proof file at $Proof" }
  $Proof = (Resolve-Path $Proof).Path
  $me = ((Native { solana address -k $Keypair }) | Select-Object -Last 1).Trim()
  Write-Host "payer: $me, balance $(Balance)"

  Push-Location $Cli
  # plumbline CLI; returns parsed --json output, or stops with $what on failure
  function PL([string]$what, [string[]]$a) {  # $what: label only
    $raw = (Native { & $Npx tsx src/main.ts --cluster $Url --keypair $Keypair --json @a }) -join "`n"
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
    return ($raw | ConvertFrom-Json)
  }

  Write-Host "== 1/5 What the proof says, and does the registry config accept it"
  $p = PL "proof inspect" @("proof", "inspect", $Proof, "--check-config")
  if (-not $p) { Fail "could not read the proof or the registry config (see the error above)" }
  Write-Host "statement $($p.statementHash)"
  Write-Host "suite     $($p.suiteCommitment)"
  Write-Host "score     $($p.correct)/$($p.total), payout $($p.payout)"
  Write-Host "image     $($p.imageId)"
  Write-Host "compose   $($p.composeHash)"
  if (-not $p.check.ok) {
    $onlyCompose = @($p.check.problems | Where-Object { $_ -notmatch "^compose" }).Count -eq 0
    if ($AdoptProofConfig) {
      Write-Host "setting registry image id, root and compose hash to the proof's (registry set-config)" -ForegroundColor Yellow
      if ($p.root -ne "44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3") { Write-Host "NOTE: this proof is under a TEST root, not Intel's. The payout flow is real; the quote is not Intel-signed." -ForegroundColor Yellow }
      $s = PL "set-config" @("registry", "set-config", "--image-id", $p.imageId, "--root-sha", $p.root, "--compose-hash", $p.composeHash)
      if (-not $s) { Fail "registry set-config failed (only the registry admin, the deploying wallet, may send it)" }
      $results.setConfigTx = $s.signature; $results.testRoot = ($p.root -ne "44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3")
      Write-Host "set-config tx $($s.signature)"; Write-Host (Explorer "tx" $s.signature)
    } elseif ($SetCompose -and $onlyCompose) {
      Write-Host "setting the registry compose hash to the proof's (registry set-config)"
      $s = PL "set-config" @("registry", "set-config", "--compose-hash", $p.composeHash)
      if (-not $s) { Fail "registry set-config failed (only the registry admin, the deploying wallet, may send it)" }
      $results.setConfigTx = $s.signature
      Write-Host "set-config tx $($s.signature)"; Write-Host (Explorer "tx" $s.signature)
    } else {
      $p.check.problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
      if ($onlyCompose) { Fail "the registry would refuse this proof; re-run with -SetCompose to set the compose hash to the proof's" }
      Fail "the registry would refuse this proof (see above); this needs a proof from the production guest"
    }
  } else { Write-Host "registry config: matches" }
  $results.statement = $p.statementHash; $results.suite = $p.suiteCommitment; $results.payout = $p.payout
  $results.score = "$($p.correct)/$($p.total)"
  if (-not $Target) { $Target = "$($p.correct)/$($p.total)" }

  Write-Host "== 2/5 suite register"
  $r = PL "suite register" @("suite", "register", $p.suiteCommitment)
  if ($r) { $results.suiteRegisterTx = $r.signature; Write-Host "suite account $($r.suite)"; Write-Host (Explorer "tx" $r.signature) }
  else { Write-Host "suite register did not go through (usually: already registered by an earlier run); continuing" -ForegroundColor Yellow }

  Write-Host "== 3/5 bounty create ($Reward SOL for $Target, deadline +$DeadlineSlots slots)"
  $b = PL "bounty create" @("bounty", "create", "--suite", $p.suiteCommitment, "--reward", $Reward, "--target", $Target,
    "--deadline-slots", "$DeadlineSlots", "--require-registered-suite")
  if (-not $b) { Fail "bounty create failed (see the error above)" }
  $results.bounty = $b.bounty; $results.bountyCreateTx = $b.signature
  Write-Host "bounty $($b.bounty)"; Write-Host (Explorer "address" $b.bounty); Write-Host (Explorer "tx" $b.signature)

  Write-Host "== 4/5 record the proof (record_verified_score)"
  $rec = PL "record" @("record", $Proof)
  if (-not $rec) {
    Fail "record failed (see the error above). If it says 'already in use', this proof was recorded before this bounty existed and cannot claim it (ScoreBeforeBounty); a fresh proof is needed. The bounty can be refunded after its deadline + grace: plumbline bounty refund $($b.bounty)"
  }
  $results.verifiedScore = $rec.score; $results.recordTx = $rec.signature
  Write-Host "VerifiedScore $($rec.score)"; Write-Host (Explorer "address" $rec.score); Write-Host (Explorer "tx" $rec.signature)

  Write-Host "== 5/5 claim (pays the payout proven in the score; the sender cannot redirect it)"
  $c = PL "claim" @("claim", $b.bounty, "--score", $rec.score)
  $paid = @($c | Where-Object { $_.signature })
  if (-not $paid.Count) { Fail "claim did not pay (see the error above)" }
  $results.claimTx = $paid[0].signature
  Write-Host "paid $Reward SOL to $($paid[0].payout)"; Write-Host (Explorer "tx" $paid[0].signature)
  Write-Host "payout balance: $((Native { solana balance $p.payout -u $Url }) | Select-Object -Last 1)"

  Pop-Location
  $results.balanceAfter = Balance
  Write-Host ""
  Write-Host "== Signatures to paste into the thread"
  foreach ($k in @("setConfigTx", "suiteRegisterTx", "bountyCreateTx", "recordTx", "claimTx")) { if ($results[$k]) { Write-Host ("{0,-16} {1}" -f $k, (Explorer "tx" $results[$k])) } }
  Write-Host ("{0,-16} {1}" -f "bounty", (Explorer "address" $results.bounty))
  Write-Host ("{0,-16} {1}" -f "verifiedScore", (Explorer "address" $results.verifiedScore))
  Write-Host "balance left     $($results.balanceAfter)"
  $results | ConvertTo-Json | Set-Content "$Kit\devnet-demo-result.json"
  Write-Host "(also saved to devnet-demo-result.json)"
} finally {
  Stop-Transcript | Out-Null
}
