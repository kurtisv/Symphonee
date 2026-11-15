using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;

// The CLI is suspended until attached to a non-breakaway Job. Every descendant
// inherits containment. Only an empty Job permits a handoff completion record.
public static class SymphoneeJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ProcessLimit;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long A,B,C,D; public uint Faults, Total, Active, Terminated;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint Size; public string Reserved, Desktop, Title;
    public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;
    public ushort Show, ReservedBytes; public IntPtr ReservedPtr, In, Out, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid,Tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup si, out ProcessInfo pi);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr a, IntPtr b, IntPtr c, out IntPtr d, uint access, bool inherit, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static Exception Error(string operation) { return new InvalidOperationException(operation + ": " + Marshal.GetLastWin32Error()); }
  static IntPtr Inherit(int kind) {
    IntPtr copy; var self=GetCurrentProcess();
    if(!DuplicateHandle(self,GetStdHandle(kind),self,out copy,0,true,2)) throw Error("DuplicateHandle");
    return copy;
  }
  public static int Run(string command, string cwd, string proofPath, string attempt) {
    Guid id; if(!Guid.TryParse(attempt,out id)) throw new ArgumentException("Invalid attempt");
    IntPtr job=IntPtr.Zero; ProcessInfo pi=new ProcessInfo(); Startup si=new Startup();
    // Hold this file exclusively against writes/deletion throughout execution.
    using(var proof=new FileStream(proofPath,FileMode.CreateNew,FileAccess.Write,FileShare.Read)) {
      try {
        job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw Error("CreateJobObject");
        ExtendedLimits limits=new ExtendedLimits(); limits.Basic.Flags=0x2000;
        if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits)))) throw Error("SetInformationJobObject");
        si.Size=(uint)Marshal.SizeOf(typeof(Startup)); si.Flags=0x100;
        si.In=Inherit(-10); si.Out=Inherit(-11); si.Error=Inherit(-12);
        if(!CreateProcess(null,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref si,out pi)) throw Error("CreateProcess");
        if(!AssignProcessToJobObject(job,pi.Process)) throw Error("AssignProcessToJobObject");
        if(ResumeThread(pi.Thread)==0xffffffff) throw Error("ResumeThread");
        Accounting info;
        do {
          if(!QueryInformationJobObject(job,1,out info,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) throw Error("QueryInformationJobObject");
          if(info.Active!=0) Thread.Sleep(25);
        } while(info.Active!=0);
        uint code; if(!GetExitCodeProcess(pi.Process,out code)) throw Error("GetExitCodeProcess");
        string json="{\"attemptId\":\""+id.ToString()+"\",\"wrapperPid\":"+Process.GetCurrentProcess().Id+",\"terminated\":true,\"scope\":\"process-tree\",\"method\":\"windows-job-object\"}";
        byte[] bytes=Encoding.UTF8.GetBytes(json); proof.Write(bytes,0,bytes.Length); proof.Flush(true);
        return unchecked((int)code);
      } finally {
        // Any setup failure leaves the root suspended. Terminate before releasing
        // handles; closing the Job also terminates every assigned descendant.
        if(pi.Process!=IntPtr.Zero) { uint code; if(GetExitCodeProcess(pi.Process,out code)&&code==259) TerminateProcess(pi.Process,125); }
        if(job!=IntPtr.Zero) CloseHandle(job);
        if(pi.Thread!=IntPtr.Zero) CloseHandle(pi.Thread);
        if(pi.Process!=IntPtr.Zero) CloseHandle(pi.Process);
        if(si.In!=IntPtr.Zero) CloseHandle(si.In);
        if(si.Out!=IntPtr.Zero) CloseHandle(si.Out);
        if(si.Error!=IntPtr.Zero) CloseHandle(si.Error);
      }
    }
  }
}
