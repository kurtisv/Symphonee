param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
try {
  $request = Get-Content -LiteralPath $RequestFile -Raw | ConvertFrom-Json
  Remove-Item -LiteralPath $RequestFile -Force
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-job.cs')
  $code = [SymphoneeJob]::Run($request.command, $request.cwd, $request.proofPath, $request.attemptId)
  exit $code
} catch {
  [Console]::Error.WriteLine('Symphonee process containment failed.')
  exit 125
}
