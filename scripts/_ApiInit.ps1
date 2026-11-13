# _ApiInit.ps1 -- shared init dot-sourced by the API helper scripts.
# The Symphonee server gates mutating requests (POST/PUT/DELETE/PATCH) behind a
# per-boot token. This resolves the token and registers it as a default header
# for Invoke-RestMethod / Invoke-WebRequest, so every script that dot-sources
# this file authenticates without touching its individual calls.
#
# Token source order (same rule as scripts/api-token.js):
#   1. config/runtime.json, ONLY when the Symphonee process that wrote it is
#      still running (its pid is alive): rewritten at every boot, it beats an
#      environment token inherited before a restart;
#   2. otherwise $env:SYMPHONEE_TOKEN.
# A runtime.json left by a Symphonee that no longer runs (for example in another
# checkout, where workers often run) is ignored: it held a stale token and every
# call was refused with 403.
#
# If no token is found we attach nothing (so reads still work, and the server's
# kill switch / disabled-enforcement modes are unaffected).

$SymphoneeToken = $null
$runtimePath = Join-Path $PSScriptRoot '..\config\runtime.json'
if (Test-Path $runtimePath) {
    try {
        $rt = Get-Content $runtimePath -Raw | ConvertFrom-Json
        if ($rt.token -and $rt.pid -and (Get-Process -Id ([int]$rt.pid) -ErrorAction SilentlyContinue)) {
            $SymphoneeToken = $rt.token
        }
    } catch { }
}
if (-not $SymphoneeToken) { $SymphoneeToken = $env:SYMPHONEE_TOKEN }

if ($SymphoneeToken) {
    if (-not $global:PSDefaultParameterValues) { $global:PSDefaultParameterValues = @{} }
    $global:PSDefaultParameterValues['Invoke-RestMethod:Headers'] = @{ 'X-Symphonee-Token' = $SymphoneeToken }
    $global:PSDefaultParameterValues['Invoke-WebRequest:Headers'] = @{ 'X-Symphonee-Token' = $SymphoneeToken }
}
