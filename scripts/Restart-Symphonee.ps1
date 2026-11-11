<#
.SYNOPSIS
  Restart Symphonee and bring the Claude sessions back, each in its own terminal.

.DESCRIPTION
  Safe to call from INSIDE a Symphonee terminal: the script first re-launches
  itself detached (WMI Win32_Process.Create), because a child of a Symphonee
  terminal dies when Symphonee closes.

  1. Restarts through Symphonee's own POST /api/restart-app (app.relaunch +
     app.exit). Falls back to closing the main window, then a forced kill.
  2. VERIFIES that the old Electron process is gone (it used to report
     "closed" even when the kill failed) and that a NEW server answers.
  3. Waits until the terminals to resume exist again (they are restored with
     their ids, e.g. main, term-3).
  4. Types "claude --dangerously-skip-permissions --resume <id>" in each target
     terminal, then optionally a follow-up message (e.g. "continue ...").

  Log: <root>\.symphonee\restart.log

.PARAMETER Resume
  One or more "termId=sessionId" pairs, e.g. "term-3=86c2d728-...".
  Default (none given): the most recent transcript of this folder in "main".

.PARAMETER Continue
  One or more "termId=text" pairs typed after the resumed sessions loaded.

.PARAMETER NoResume
  Restart only, do not type anything in any terminal.

.EXAMPLE
  powershell.exe -ExecutionPolicy Bypass -NoProfile -File scripts\Restart-Symphonee.ps1 `
    -Resume 'term-3=86c2d728-bcb1-4637-8336-2193dc72369a' -Continue 'term-3=continue'
#>
param(
  [string[]]$Resume = @(),
  [string[]]$Continue = @(),
  [string]$SessionId = '',
  [switch]$NoResume,
  [switch]$DryRun,
  [string]$ArgsFile = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = 3800
$base = "http://127.0.0.1:$port"
$logFile = Join-Path $root '.symphonee\restart.log'
function Log([string]$m) {
  $line = "[$(Get-Date -Format s)] $m"
  Write-Host $line
  try { Add-Content -Path $logFile -Value $line -Encoding UTF8 } catch { }
}
function Token { (Get-Content (Join-Path $root 'config\runtime.json') -Raw | ConvertFrom-Json).token }
function Post([string]$path, $body) {
  Invoke-RestMethod "$base$path" -Method Post -ContentType 'application/json' -Headers @{ 'x-symphonee-token' = (Token) } `
    -Body ($body | ConvertTo-Json -Compress) -TimeoutSec 30
}
function MainPid {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return [int]$c.OwningProcess } else { return $null }
}
function Pairs([string[]]$items) {
  $out = @()
  foreach ($i in $items) {
    $k = $i.IndexOf('=')
    if ($k -lt 1) { throw "Expected termId=value, got: $i" }
    $out += [pscustomobject]@{ Term = $i.Substring(0, $k).Trim(); Value = $i.Substring($k + 1) }
  }
  return $out
}

# 0. Detach from the calling terminal. Parameters travel in a JSON file: a
# command line cannot carry repeated array parameters (-File rejects them)
# nor arbitrary message text safely.
if (-not $ArgsFile) {
  $argsPath = Join-Path $root ('.symphonee\restart-args-' + [guid]::NewGuid().ToString('N') + '.json')
  @{ Resume = @($Resume); Continue = @($Continue); SessionId = $SessionId; NoResume = [bool]$NoResume; DryRun = [bool]$DryRun } |
    ConvertTo-Json -Depth 4 | Set-Content -Path $argsPath -Encoding UTF8
  $cmd = 'powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "' + $PSCommandPath + '" -ArgsFile "' + $argsPath + '"'
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $root }
  if ($r.ReturnValue -ne 0) { throw "Could not start the detached restarter (WMI code $($r.ReturnValue))" }
  Write-Host "Detached restarter started (PID $($r.ProcessId)). Log: $logFile"
  return
}

try {
  Log "--- restart requested (args $ArgsFile)"
  $a = Get-Content $ArgsFile -Raw -Encoding UTF8 | ConvertFrom-Json
  Remove-Item $ArgsFile -Force -ErrorAction SilentlyContinue
  $Resume = @($a.Resume | Where-Object { $_ }); $Continue = @($a.Continue | Where-Object { $_ })
  $SessionId = [string]$a.SessionId; $NoResume = [bool]$a.NoResume; $DryRun = [bool]$a.DryRun
  # Which sessions to bring back, in which terminal.
  $resumePairs = @(Pairs $Resume)
  if (-not $NoResume -and $resumePairs.Count -eq 0) {
    if (-not $SessionId) {
      $slug = ($root -replace '[^A-Za-z0-9]', '-')
      $dir = Join-Path $env:USERPROFILE ".claude\projects\$slug"
      $last = Get-ChildItem $dir -Filter *.jsonl -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if ($last) { $SessionId = $last.BaseName }
    }
    if ($SessionId) { $resumePairs = @([pscustomobject]@{ Term = 'main'; Value = $SessionId }) }
  }
  foreach ($p in $resumePairs) { if ($p.Value -notmatch '^[0-9a-fA-F-]{36}$') { throw "Unexpected session id: $($p.Value)" } }
  $continuePairs = @(Pairs $Continue)
  Log ('resume: ' + (($resumePairs | ForEach-Object { "$($_.Term)=$($_.Value)" }) -join ', '))

  # 1. Restart via the app itself.
  $old = MainPid
  if (-not $old) { throw "Nothing listens on port ${port}: is Symphonee running?" }
  if ($DryRun) {
    Log ("dry run: would restart PID $old; continue: " + (($continuePairs | ForEach-Object { "$($_.Term)=[$($_.Value)]" }) -join ', '))
    Log '--- dry run done'
    return
  }
  $running = try { (Invoke-RestMethod "$base/api/orchestrator/status" -TimeoutSec 20).runningTasks } catch { 0 }
  if ($running -gt 0) { Log "WARNING: $running orchestrator task(s) running; they will be lost." }
  try { $null = Post '/api/restart-app' @{}; Log "restart-app accepted by PID $old" }
  catch { Log "restart-app failed ($_); closing the window instead" ; try { [void](Get-Process -Id $old).CloseMainWindow() } catch { } }

  # 2. The old process must really be gone.
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Process -Id $old -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (Get-Process -Id $old -ErrorAction SilentlyContinue) {
    Log "old PID $old still alive after 45 s: forcing"
    & taskkill /PID $old /T /F 2>&1 | ForEach-Object { Log "taskkill: $_" }
    Start-Sleep -Seconds 3
    if (Get-Process -Id $old -ErrorAction SilentlyContinue) { throw "PID $old could not be terminated. Nothing relaunched." }
    # A forced kill does not relaunch: start it from the shortcut (or npm start).
    $lnk = Join-Path $env:USERPROFILE 'Desktop\Symphonee.lnk'
    if (Test-Path $lnk) { Start-Process $lnk } else { Start-Process -FilePath 'npm.cmd' -ArgumentList 'start' -WorkingDirectory $root -WindowStyle Hidden }
    Log 'relaunched after forced kill'
  } else { Log "old PID $old exited" }

  # 3. New server + terminals to resume.
  $need = @($resumePairs | ForEach-Object { $_.Term }) + @($continuePairs | ForEach-Object { $_.Term }) | Select-Object -Unique
  $ready = $false
  $deadline = (Get-Date).AddSeconds(300)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $now = MainPid
    if (-not $now -or $now -eq $old) { continue }
    try {
      $ids = @((Invoke-RestMethod "$base/api/terminals/diag" -TimeoutSec 10).terminals | ForEach-Object { $_.id })
      if (@($need | Where-Object { $ids -notcontains $_ }).Count -eq 0 -and $ids -contains 'main') { $ready = $true; break }
    } catch { }
  }
  if (-not $ready) { throw "New server or terminals ($($need -join ', ')) not ready after 300 s." }
  Log "new server PID $(MainPid); terminals ready: $($need -join ', ')"
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like "*$root*" } | ForEach-Object {
    try { (Get-Process -Id $_.ProcessId).PriorityClass = 'AboveNormal' } catch { }
  }

  # 4. Resume each session in its own terminal, then the follow-up messages.
  if (-not $NoResume) {
    Start-Sleep -Seconds 3
    foreach ($p in $resumePairs) {
      $r = Post '/api/orchestrator/inject' @{ termId = $p.Term; text = "claude --dangerously-skip-permissions --resume $($p.Value)" }
      Log "resume typed in $($p.Term): ok=$($r.ok)"
    }
    if ($continuePairs.Count -gt 0) {
      Start-Sleep -Seconds 40
      foreach ($c in $continuePairs) {
        $r = Post '/api/orchestrator/inject' @{ termId = $c.Term; text = $c.Value }
        Log "follow-up typed in $($c.Term): ok=$($r.ok)"
      }
    }
  }
  Log '--- restart done'
} catch {
  Log "ERROR: $_"
  exit 1
}
