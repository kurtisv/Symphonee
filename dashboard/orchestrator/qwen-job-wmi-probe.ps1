param()
$ErrorActionPreference = 'Stop'
$marker = 'sym-job-' + [guid]::NewGuid().ToString('N')
$outFile = Join-Path ([IO.Path]::GetTempPath()) ($marker + '.txt')
$childPid = 0
$source = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class SymJobProbe {
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long a,b; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,schedule; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC basic; public IO io; public UIntPtr a,b,c,d; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct START { public uint cb; public string reserved,desktop,title; public uint x,y,xs,ys,xc,yc,fill,flags; public ushort show,cb2; public IntPtr p2,stdin,stdout,stderr; }
  [StructLayout(LayoutKind.Sequential)] struct PROC { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr p,uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref START s,out PROC p);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr p,IntPtr j,out bool result);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr p,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr p,out long creation,out long exit,out long kernel,out long user);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static IntPtr job=IntPtr.Zero;
  public static uint Start(string exe,string arguments) {
    job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    EXT e=new EXT(); e.basic.flags=0x2000; int n=Marshal.SizeOf(typeof(EXT)); IntPtr mem=Marshal.AllocHGlobal(n);
    try { Marshal.StructureToPtr(e,mem,false); if(!SetInformationJobObject(job,9,mem,(uint)n)) throw new System.ComponentModel.Win32Exception(); } finally { Marshal.FreeHGlobal(mem); }
    START s=new START(); s.cb=(uint)Marshal.SizeOf(typeof(START)); PROC p;
    if(!CreateProcess(exe,new StringBuilder("\""+exe+"\" "+arguments),IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,null,ref s,out p)) throw new System.ComponentModel.Win32Exception();
    try { bool inside; if(!AssignProcessToJobObject(job,p.process) || !IsProcessInJob(p.process,job,out inside) || !inside) { TerminateProcess(p.process,1); throw new System.ComponentModel.Win32Exception(); } if(ResumeThread(p.thread)==0xffffffff) { TerminateProcess(p.process,1); throw new System.ComponentModel.Win32Exception(); } return p.pid; }
    finally { CloseHandle(p.thread); CloseHandle(p.process); }
  }
  public static bool Contains(uint pid) { IntPtr p=OpenProcess(0x1000,false,pid); if(p==IntPtr.Zero) throw new System.ComponentModel.Win32Exception(); try { bool result; if(!IsProcessInJob(p,job,out result)) throw new System.ComponentModel.Win32Exception(); return result; } finally { CloseHandle(p); } }
  public static IntPtr OpenForCleanup(uint pid) { return OpenProcess(0x1001,false,pid); }
  public static DateTime CreatedUtc(IntPtr p) { long a,b,c,d; if(!GetProcessTimes(p,out a,out b,out c,out d)) throw new System.ComponentModel.Win32Exception(); return DateTime.FromFileTimeUtc(a); }
  public static void TerminateHeld(IntPtr p) { if(!TerminateProcess(p,1)) throw new System.ComponentModel.Win32Exception(); }
  public static void CloseHeld(IntPtr p) { if(p!=IntPtr.Zero) CloseHandle(p); }
  public static void Close() { if(job!=IntPtr.Zero) { CloseHandle(job); job=IntPtr.Zero; } }
}
'@
try {
  Add-Type -TypeDefinition $source
  $exe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $escapedFile = $outFile.Replace("'", "''")
  $childCommand = '"' + $exe + '" -NoProfile -NonInteractive -WindowStyle Hidden -Command "Start-Sleep -Seconds 20; #' + $marker + '"'
  $escapedCommand = $childCommand.Replace("'", "''")
  $script = '$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=' + "'" + $escapedCommand + "'" + '}; [IO.File]::WriteAllText(' + "'" + $escapedFile + "'" + ', ($r.ReturnValue.ToString()+ '','' + $r.ProcessId.ToString()))'
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
  $parentPid = [SymJobProbe]::Start($exe, '-NoProfile -NonInteractive -EncodedCommand ' + $encoded)
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  while (!(Test-Path -LiteralPath $outFile) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if (!(Test-Path -LiteralPath $outFile)) { throw 'WMI test did not return' }
  $parts = [IO.File]::ReadAllText($outFile).Split(',')
  if ($parts[0] -ne '0') { throw ('WMI creation refused, code ' + $parts[0]) }
  $childPid = [int]$parts[1]
  $child = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $childPid)
  if (!$child -or !$child.CommandLine.Contains($marker)) { throw 'Fixture process identity not verified' }
  $member = [SymJobProbe]::Contains([uint32]$childPid)
  [SymJobProbe]::Close()
  $alive = [bool](Get-Process -Id $childPid -ErrorAction SilentlyContinue)
  [pscustomobject]@{ parentPid=$parentPid; childPid=$childPid; childInJob=$member; childAliveAfterJobClose=$alive } | ConvertTo-Json -Compress
} finally {
  try { [SymJobProbe]::Close() } catch {}
  if ($childPid -gt 0) {
    $held = [SymJobProbe]::OpenForCleanup([uint32]$childPid)
    if ($held -ne [IntPtr]::Zero) {
      try {
        $check = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $childPid) -ErrorAction SilentlyContinue
        $created = [SymJobProbe]::CreatedUtc($held)
        if (!$check -or !$check.CommandLine -or !$check.CommandLine.Contains($marker) -or [math]::Abs(($check.CreationDate.ToUniversalTime() - $created).TotalSeconds) -gt 1) { throw 'Fixture identity changed; cleanup refused' }
        [SymJobProbe]::TerminateHeld($held)
      } finally { [SymJobProbe]::CloseHeld($held) }
      Wait-Process -Id $childPid -Timeout 3 -ErrorAction SilentlyContinue
      $remaining = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $childPid) -ErrorAction SilentlyContinue
      if ($remaining -and $remaining.CommandLine -and $remaining.CommandLine.Contains($marker)) { throw 'Fixture process cleanup failed' }
    }
  }
  Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
}
