# _ApiInit.ps1 -- shared init dot-sourced by the API helper scripts.
# The Symphonee server gates mutating requests (POST/PUT/DELETE/PATCH) behind a
# per-boot token. This resolves the token and registers it as a default header
# for Invoke-RestMethod / Invoke-WebRequest, so every script that dot-sources
# this file authenticates without touching its individual calls.
#
# Token source order:
#   1. config/runtime.json   -- rewritten at every boot (always current)
#   2. $env:SYMPHONEE_TOKEN  -- fallback; goes stale after a restart
#
# If no token is found we attach nothing (so reads still work, and the server's
# kill switch / disabled-enforcement modes are unaffected).

$SymphoneeToken = $null
$runtimePath = Join-Path $PSScriptRoot '..\config\runtime.json'
if (Test-Path $runtimePath) {
    try { $SymphoneeToken = (Get-Content $runtimePath -Raw | ConvertFrom-Json).token } catch { }
}
if (-not $SymphoneeToken) { $SymphoneeToken = $env:SYMPHONEE_TOKEN }

if ($SymphoneeToken) {
    if (-not $global:PSDefaultParameterValues) { $global:PSDefaultParameterValues = @{} }
    $global:PSDefaultParameterValues['Invoke-RestMethod:Headers'] = @{ 'X-Symphonee-Token' = $SymphoneeToken }
    $global:PSDefaultParameterValues['Invoke-WebRequest:Headers'] = @{ 'X-Symphonee-Token' = $SymphoneeToken }
}
