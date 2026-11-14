using System;
using System.IO;
using System.Text;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// Experimental primitive; not wired to any autopilot. Open the actual target
// without following a final reparse point, pin its handle, resolve the path of
// that handle, and reject hardlinks. A failed write may be partial: callers must
// halt and inspect the worktree rather than retrying it automatically.
public static class SymphoneeCheckedWrite {
  const uint READ = 0x80000000, WRITE = 0x40000000, SHARE_READ = 1, OPEN_EXISTING = 3;
  const uint BACKUP = 0x02000000, REPARSE = 0x00200000, ATTR_REPARSE = 0x400, ATTR_DIR = 0x10;
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes, CreateLow, CreateHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string file, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file, out Info info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint length, uint flags);
  static string Final(SafeFileHandle h) { var s = new StringBuilder(32768); uint n = GetFinalPathNameByHandle(h, s, (uint)s.Capacity, 0); if (n == 0 || n >= s.Capacity) throw new IOException("Cannot resolve handle"); return s.ToString().TrimEnd('\\'); }
  static Info GetInfo(SafeFileHandle h) { Info info; if (h.IsInvalid || !GetFileInformationByHandle(h, out info)) throw new IOException("Cannot inspect handle"); return info; }
  static string RootPath(SafeFileHandle h, string root, Info info) {
    if ((info.Attributes & ATTR_REPARSE) != 0 || (info.Attributes & ATTR_DIR) == 0) throw new IOException("Invalid root");
    string full = Path.GetFullPath(root).TrimEnd('\\');
    if (full.StartsWith("\\\\", StringComparison.Ordinal)) throw new IOException("UNC roots unsupported");
    string final = Final(h); if (!String.Equals(final, "\\\\?\\" + full, StringComparison.OrdinalIgnoreCase)) throw new IOException("Root resolves through an alias");
    return final;
  }
  static string Identity(Info i) { return i.Volume.ToString("x8") + i.IndexHigh.ToString("x8") + i.IndexLow.ToString("x8"); }
  static string Hash(byte[] b) { using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(b)).Replace("-", "").ToLowerInvariant(); }
  public static string Read(string root, string relative) {
    if (String.IsNullOrEmpty(relative) || Path.IsPathRooted(relative) || relative.IndexOf(':') >= 0 || relative.IndexOf('\\') >= 0) throw new ArgumentException("Invalid input");
    foreach (var p in relative.Split('/')) if (String.IsNullOrEmpty(p) || p == "." || p == ".." || String.Equals(p, ".git", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Invalid path");
    using (var r = CreateFile(root, READ, SHARE_READ, IntPtr.Zero, OPEN_EXISTING, BACKUP | REPARSE, IntPtr.Zero)) {
      var ri = GetInfo(r); string basePath = RootPath(r, root, ri); string full = Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar));
      using (var f = CreateFile(full, READ, SHARE_READ, IntPtr.Zero, OPEN_EXISTING, REPARSE, IntPtr.Zero)) {
        var info = GetInfo(f); if ((info.Attributes & (ATTR_REPARSE | ATTR_DIR)) != 0 || info.Links != 1 || info.SizeHigh != 0 || info.SizeLow > 24000) throw new IOException("Invalid target");
        if (!String.Equals(Final(f), basePath + "\\" + relative.Replace('/', '\\'), StringComparison.OrdinalIgnoreCase)) throw new IOException("Resolved path differs from requested path");
        using (var stream = new FileStream(f, FileAccess.Read)) {
          byte[] content = new byte[(int)info.SizeLow]; int pos = 0, count; while (pos < content.Length && (count = stream.Read(content, pos, content.Length - pos)) > 0) pos += count;
          if (pos != content.Length) throw new IOException("Incomplete read");
          string text = new UTF8Encoding(false, true).GetString(content); if (text.IndexOf('\0') >= 0) throw new IOException("Binary target"); return Identity(ri) + "\n" + text;
        }
      }
    }
  }
  public static string Apply(string root, string relative, string expectedRoot, string expectedHash, string oldText, string newText) {
    if (String.IsNullOrEmpty(relative) || Path.IsPathRooted(relative) || relative.IndexOf(':') >= 0 || relative.IndexOf('\\') >= 0 || String.IsNullOrEmpty(oldText) || newText == null || newText.IndexOf('\0') >= 0) throw new ArgumentException("Invalid input");
    foreach (var p in relative.Split('/')) if (String.IsNullOrEmpty(p) || p == "." || p == ".." || String.Equals(p, ".git", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Invalid path");
    using (var r = CreateFile(root, READ, SHARE_READ, IntPtr.Zero, OPEN_EXISTING, BACKUP | REPARSE, IntPtr.Zero)) {
      var ri = GetInfo(r); string basePath = RootPath(r, root, ri); if (!String.Equals(Identity(ri), expectedRoot, StringComparison.Ordinal)) throw new IOException("Worktree root changed");
      string full = Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar));
      using (var f = CreateFile(full, READ | WRITE, SHARE_READ, IntPtr.Zero, OPEN_EXISTING, REPARSE, IntPtr.Zero)) {
        var info = GetInfo(f); if ((info.Attributes & (ATTR_REPARSE | ATTR_DIR)) != 0 || info.Links != 1 || info.SizeHigh != 0 || info.SizeLow > 24000) throw new IOException("Invalid target");
        string final = Final(f);
        // Equality rejects internal junctions to a different path, DOS 8.3
        // aliases, and names normalized by Windows (trailing dot/space).
        string requested = basePath + "\\" + relative.Replace('/', '\\');
        if (!String.Equals(final, requested, StringComparison.OrdinalIgnoreCase)) throw new IOException("Resolved path differs from requested path");
        using (var stream = new FileStream(f, FileAccess.ReadWrite)) {
          byte[] original = new byte[(int)info.SizeLow]; int pos = 0, count; while (pos < original.Length && (count = stream.Read(original, pos, original.Length - pos)) > 0) pos += count;
          if (pos != original.Length || !String.Equals(Hash(original), expectedHash, StringComparison.Ordinal)) throw new IOException("Stale target");
          string text = new UTF8Encoding(false, true).GetString(original); if (text.IndexOf('\0') >= 0) throw new IOException("Binary target");
          int start = text.IndexOf(oldText, StringComparison.Ordinal); if (start < 0 || text.IndexOf(oldText, start + 1, StringComparison.Ordinal) >= 0) throw new IOException("Ambiguous target");
          string updated = text.Substring(0, start) + newText + text.Substring(start + oldText.Length); byte[] result = new UTF8Encoding(false, true).GetBytes(updated);
          if (result.Length > 24000 || Hash(result) == expectedHash) throw new IOException("Invalid result");
          stream.Position = 0; stream.Write(result, 0, result.Length); stream.SetLength(result.Length); stream.Flush(true); return Hash(result);
        }
      }
    }
  }
}
