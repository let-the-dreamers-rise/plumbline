# One command for the laptop: deploy the Plumbline registry + escrow to devnet, then pay one devnet bounty
# from a real Groth16 proof (TEST ROOT quote; the payout flow is real). Devnet only, no faucet.
#   powershell -ExecutionPolicy Bypass -File run-all.ps1
param([string]$Repo = "")
$ErrorActionPreference = "Stop"
$Kit = $PSScriptRoot
$repoArg = @(); if ($Repo) { $repoArg = @("-Repo", $Repo) }
& powershell -ExecutionPolicy Bypass -File "$Kit\deploy-devnet.ps1" @repoArg
if ($LASTEXITCODE -ne 0) { Write-Host "deploy step stopped; fix the message above and run this again (finished steps are skipped)" -ForegroundColor Red; exit 1 }
$root = if ($Repo) { $Repo } elseif (Test-Path "$Kit\..\plumbline") { "$Kit\.." } else { "$Kit\..\paid-compute-tape" }
$proof = Join-Path $root "plumbline\programs\tests\fixtures\synthetic-payout-groth16.json"
& powershell -ExecutionPolicy Bypass -File "$Kit\devnet-demo.ps1" -Proof $proof -AdoptProofConfig @repoArg
if ($LASTEXITCODE -ne 0) { exit 1 }
Write-Host ""
Write-Host "DONE. Paste deploy-devnet-result.json and devnet-demo-result.json (both in $Kit) into the project thread." -ForegroundColor Green
