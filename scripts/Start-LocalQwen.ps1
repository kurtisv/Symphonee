# Starts the LM Studio server and loads qwen/qwen3.5-9b with the 8192 context the autopilot requires.
# Run at Windows logon and every 30 minutes by the scheduled task "Symphonee Qwen local". Safe to run again: it only loads when missing.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root '.symphonee\local-qwen.log'
function Note([string]$m) { Add-Content -Path $log -Value "[$(Get-Date -Format s)] $m" -Encoding UTF8 }
$lms = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
if (-not (Test-Path $lms)) { Note "lms.exe not found at $lms"; exit 1 }
$model = 'qwen/qwen3.5-9b'
for ($i = 1; $i -le 10; $i++) {
  # "lms server start" restarts a running server and drops the request Qwen is waiting on (seen 2026-11-22 16:31 and 17:01):
  # a server that LISTENS on 1234 is running, even when it is too busy to answer quickly. Only a closed port is started.
  if (Get-NetTCPConnection -LocalPort 1234 -State Listen -ErrorAction SilentlyContinue) {
    try { $null = Invoke-RestMethod 'http://127.0.0.1:1234/v1/models' -TimeoutSec 60; break } catch { Note "server listening but slow (try $i)"; Start-Sleep -Seconds 15; continue }
  }
  & $lms server start 2>&1 | Out-Null
  try { $null = Invoke-RestMethod 'http://127.0.0.1:1234/v1/models' -TimeoutSec 10; break } catch { Note "server not ready (try $i)"; Start-Sleep -Seconds 15 }
}
try { $null = Invoke-RestMethod 'http://127.0.0.1:1234/v1/models' -TimeoutSec 60 } catch { Note 'server never answered after 10 tries; model not loaded'; exit 1 }
# The model and its 8192 context must be on the SAME line of "lms ps" (another model or column must not count).
$line = '(?m)^.*' + [regex]::Escape($model) + '.*\b8192\b.*$'
$ps = (& $lms ps 2>&1 | Out-String)
if ($ps -match $line) { Note "$model already loaded (8192)"; exit 0 }
$out = (& $lms load $model --context-length 8192 -y 2>&1 | Out-String)
$ps = (& $lms ps 2>&1 | Out-String)
if ($ps -match $line) { Note "$model loaded (8192)" } else { Note ("load failed: " + (($out -split "`r?`n" | Where-Object { $_.Trim() }) | Select-Object -Last 1)); exit 1 }
