<#
.SYNOPSIS
  Restart Symphonee and bring the Claude session of the main terminal back.

.DESCRIPTION
  1. Finds the Claude Code session that was running in Symphonee (most recent
     transcript of this folder, or -SessionId).
  2. Closes Symphonee gracefully (falls back to a forced close after 30 s).
  3. Relaunches it from the Desktop shortcut (launching from a terminal gets
     it killed when that terminal closes).
  4. Waits for the server and the main terminal, raises the process priority.
  5. Types "claude --dangerously-skip-permissions --resume <id>" in the main
     terminal through POST /api/orchestrator/inject.

  The resumed session comes back with its history but its interrupted turn is
  not replayed: type "continue" in it if it was in the middle of something.

.PARAMETER SessionId
  Claude session id to resume. Default: most recently written transcript.

.PARAMETER NoResume
  Restart only, do not type anything in the terminal.
#>
param(
  [string]$SessionId = '',
  [switch]$NoResume
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = 3800
$base = "http://127.0.0.1:$port"
$lnk = Join-Path $env:USERPROFILE 'Desktop\Symphonee.lnk'
if (-not (Test-Path $lnk)) { throw "Desktop shortcut not found: $lnk" }

# 1. Which Claude session to bring back
if (-not $NoResume -and -not $SessionId) {
  $slug = ($root -replace '[^A-Za-z0-9]', '-')
  $dir = Join-Path $env:USERPROFILE ".claude\projects\$slug"
  if (Test-Path $dir) {
    $last = Get-ChildItem $dir -Filter *.jsonl | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($last) { $SessionId = $last.BaseName }
  }
  if (-not $SessionId) { Write-Host "No Claude transcript found in $dir : restarting without resume." }
}
if ($SessionId -and $SessionId -notmatch '^[0-9a-fA-F-]{36}$') { throw "Unexpected session id format: $SessionId" }
if ($SessionId) { Write-Host "Claude session to resume: $SessionId" }

# 2. Close Symphonee
$main = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -like "*$root*" -and $_.CommandLine -notmatch '--type=' } | Select-Object -First 1
if ($main) {
  $running = try { (Invoke-RestMethod "$base/api/orchestrator/status" -TimeoutSec 20).runningTasks } catch { 0 }
  if ($running -gt 0) { Write-Host "WARNING: $running orchestrator task(s) running; they will be lost." }
  $p = Get-Process -Id $main.ProcessId
  [void]$p.CloseMainWindow()
  $waited = 0
  while (-not $p.HasExited -and $waited -lt 30) { Start-Sleep -Milliseconds 500; $waited += 0.5; $p.Refresh() }
  if (-not $p.HasExited) {
    Write-Host "Graceful close timed out, forcing."
    & taskkill /PID $main.ProcessId /T /F | Out-Null
  }
  Write-Host ("Symphonee closed after {0} s." -f $waited)
} else {
  Write-Host "Symphonee was not running."
}
# The old Claude process must be gone before the same session is resumed.
$deadline = (Get-Date).AddSeconds(20)
do {
  $old = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like "*$root*" }
  $busy = [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  if (-not $old -and -not $busy) { break }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)
if ($old -or $busy) { throw "Symphonee is still running or port $port is still in use. Nothing relaunched." }

# 3. Relaunch from the shortcut
Start-Process $lnk
Write-Host "Relaunched. Waiting for the server and the main terminal..."

# 4. Wait for server + main terminal
$ready = $false
$deadline = (Get-Date).AddSeconds(300)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  try {
    $diag = Invoke-RestMethod "$base/api/terminals/diag" -TimeoutSec 10
    if ($diag.terminals | Where-Object { $_.id -eq 'main' }) { $ready = $true; break }
  } catch { }
}
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like "*$root*" } | ForEach-Object {
  try { (Get-Process -Id $_.ProcessId).PriorityClass = 'AboveNormal' } catch { }
}
if (-not $ready) { throw "Server or main terminal not ready after 300 s. Open a terminal in Symphonee and run: claude --dangerously-skip-permissions --resume $SessionId" }
Write-Host "Server and main terminal ready. Priority set to AboveNormal."

# 5. Resume the Claude session in the main terminal
if ($SessionId -and -not $NoResume) {
  Start-Sleep -Seconds 3   # let the shell print its prompt
  $token = (Get-Content (Join-Path $root 'config\runtime.json') -Raw | ConvertFrom-Json).token
  $body = @{ termId = 'main'; text = "claude --dangerously-skip-permissions --resume $SessionId" } | ConvertTo-Json
  $r = Invoke-RestMethod "$base/api/orchestrator/inject" -Method Post -ContentType 'application/json' -Headers @{ 'x-symphonee-token' = $token } -Body $body -TimeoutSec 30
  if ($r.ok) { Write-Host "Resume command typed in the main terminal. Type 'continue' there if the session was mid-task." }
  else { throw "Inject failed: $($r | ConvertTo-Json -Compress)" }
}
