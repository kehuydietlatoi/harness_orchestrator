// Windows run owner. Assign the suspended root before any user code can spawn.
// Job membership survives DETACHED_PROCESS, reparenting, and nested jobs. No breakaway is allowed.
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;

class RunOwner {
    [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public long processTime, jobTime;
        public uint flags;
        public UIntPtr min, max;
        public uint active;
        public UIntPtr affinity;
        public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Extended {
        public Limits basic;
        public IO io;
        public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long a,b,c,d;
        public uint faults, total, active, terminated;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public int size;
        public string reserved, desktop, title;
        public uint x,y,width,height,xChars,yChars,fill,flags;
        public ushort show, reservedSize;
        public IntPtr reservedPtr, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr sa, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended data, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting data, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr psa, IntPtr tsa, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    // CommandLineToArgvW / CRT quoting: preserve quotes, trailing slashes, empty args and metacharacters.
    static string Quote(string arg) {
        var s = new StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in arg) {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') { s.Append('\\', slashes * 2 + 1); s.Append(ch); }
            else { s.Append('\\', slashes); s.Append(ch); }
            slashes = 0;
        }
        s.Append('\\', slashes * 2); s.Append('"');
        return s.ToString();
    }
    static Exception Failure(string operation) {
        return new Exception(operation + " failed: Win32 error " + Marshal.GetLastWin32Error());
    }
    static int Main(string[] args) {
        IntPtr job = IntPtr.Zero;
        ProcessInfo p = new ProcessInfo();
        bool assigned = false;
        try {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw Failure("CreateJobObject");
            var limits = new Extended();
            limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw Failure("SetInformationJobObject");
            var startup = new Startup();
            startup.size = Marshal.SizeOf(startup);
            startup.flags = 0x100; // STARTF_USESTDHANDLES
            startup.input = GetStdHandle(-10); startup.output = GetStdHandle(-11); startup.error = GetStdHandle(-12);
            var command = new StringBuilder();
            bool shell = args.Length == 6 && Path.GetFileName(args[1]).Equals("cmd.exe", StringComparison.OrdinalIgnoreCase) && args[2] == "/d" && args[3] == "/s" && args[4] == "/c";
            for (int i = 1; i < args.Length; i++) {
                if (i > 1) command.Append(' ');
                command.Append(shell && i >= 2 ? args[i] : Quote(args[i]));
            }
            if (!CreateProcess(null, command, IntPtr.Zero, IntPtr.Zero, true, 4 | 0x08000000, IntPtr.Zero, null, ref startup, out p)) throw Failure("CreateProcess " + args[1]);
            if (!AssignProcessToJobObject(job, p.process)) throw Failure("AssignProcessToJobObject PID " + p.pid);
            assigned = true;
            if (!File.Exists(Path.Combine(args[0], "stop")) && ResumeThread(p.thread) == 0xffffffff) throw Failure("ResumeThread");
            while (WaitForSingleObject(p.process, 10) == 258) {
                if (File.Exists(Path.Combine(args[0], "stop"))) {
                    // Preserve the timeout tree-kill behavior; the Job handles detached orphans too.
                    var start = new ProcessStartInfo("taskkill.exe", "/pid " + p.pid + " /T /F");
                    start.UseShellExecute = false; start.CreateNoWindow = true;
                    start.RedirectStandardOutput = true; start.RedirectStandardError = true;
                    try { using (var killer = Process.Start(start)) { if (!killer.WaitForExit(5000)) { killer.Kill(); killer.WaitForExit(); } } }
                    catch (Exception e) { Console.Error.WriteLine("[process-run] WARNING: taskkill PID " + p.pid + ": " + e.Message); }
                    break;
                }
            }
            uint code;
            if (!GetExitCodeProcess(p.process, out code)) throw Failure("GetExitCodeProcess");
            Drain(job, p.pid);
            return unchecked((int)code);
        } catch (Exception e) {
            Console.Error.WriteLine("[process-run] WARNING: " + e.Message);
            if (p.process != IntPtr.Zero) {
                TerminateProcess(p.process, 127);
                if (WaitForSingleObject(p.process, 5000) != 0) Console.Error.WriteLine("[process-run] WARNING: cannot confirm termination of PID " + p.pid);
            }
            if (assigned) {
                try { Drain(job, p.pid); }
                catch (Exception cleanup) { Console.Error.WriteLine("[process-run] WARNING: " + cleanup.Message); }
            }
            return 127;
        } finally {
            if (p.thread != IntPtr.Zero) CloseHandle(p.thread);
            if (p.process != IntPtr.Zero) CloseHandle(p.process);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
    static void Drain(IntPtr job, uint pid) {
        if (!TerminateJobObject(job, 1)) throw Failure("TerminateJobObject for root PID " + pid);
        Accounting stats;
        for (;;) {
            if (!QueryInformationJobObject(job, 1, out stats, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw Failure("QueryInformationJobObject for root PID " + pid);
            if (stats.active == 0) return;
            Thread.Sleep(1);
        }
    }
}
