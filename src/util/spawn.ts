import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";

/**
 * Kill `child` and everything it started.
 *
 * On Windows the harnesses are launched through `cmd.exe` (so `.cmd` shims resolve), which makes the direct
 * child a shell wrapper: killing only it leaves the real harness, and anything it spawned, running. That is
 * not hypothetical - a review that hit its timeout was reported as failed while Codex carried on for another
 * 44 minutes, burning usage, and its verdict was lost. `taskkill /T` takes the whole tree. On POSIX the
 * harness is the direct child (no shell), so killing it directly is already right.
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill("SIGKILL")); // taskkill missing: at least stop the wrapper
    return;
  }
  child.kill("SIGKILL");
}

export interface SpawnResult {
  code: number; // 124 = timed out, 125 = aborted by `abortOn`, 127 = failed to start
  durationMs: number;
  timedOut: boolean;
  /** Why `abortOn` stopped the child early; absent when it ran to completion or timed out. */
  aborted?: string;
}

/**
 * Spawn a long-running child, streaming stdout+stderr to a log file.
 * The prompt is delivered on stdin (via `input`) so it never touches argv —
 * avoiding shell-quoting hazards. On Windows we run through the shell so that
 * `.cmd` / `.ps1` CLI shims (claude, codex) resolve; keep argv values simple
 * (no spaces / shell metacharacters) since the shell does not re-quote them.
 */
export function spawnLogged(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    logFile?: string;
    timeoutMs?: number;
    input?: string;
    env?: NodeJS.ProcessEnv;
    shell?: boolean;
    /**
     * Inspect each complete output line; return a reason to kill the child's whole process tree at once.
     * For failure modes a timeout only catches late (e.g. a harness idling on its own sub-agents).
     */
    abortOn?: (line: string) => string | undefined;
  } = {},
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    // With shell:true, passing a separate args array concatenates without
    // escaping (Node DEP0190). We keep argv metachar-free and collapse to a
    // single command string here so no unescaped args array is passed.
    const useShell = opts.shell ?? false;
    let command = cmd;
    let spawnArgs = args;
    if (useShell && args.length) {
      const q = (s: string): string => (/\s/.test(s) ? `"${s}"` : s);
      command = [cmd, ...args].map(q).join(" ");
      spawnArgs = [];
    }
    const child = spawn(command, spawnArgs, {
      cwd: opts.cwd,
      shell: useShell,
      env: opts.env ?? process.env,
      windowsHide: true,
    });

    const log = opts.logFile ? createWriteStream(opts.logFile, { flags: "a" }) : null;
    let aborted: string | undefined;
    // Per-stream line buffers: a chunk boundary can fall mid-line, and stdout/stderr must not interleave.
    const watch = (): ((d: Buffer) => void) => {
      let pending = "";
      return (d) => {
        if (!opts.abortOn || aborted !== undefined) return;
        const lines = (pending + d.toString("utf8")).split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const reason = opts.abortOn(line);
          if (reason === undefined) continue;
          aborted = reason;
          killProcessTree(child);
          return;
        }
      };
    };
    const onOut = watch();
    const onErr = watch();
    child.stdout?.on("data", (d: Buffer) => {
      if (log) log.write(d);
      onOut(d);
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (log) log.write(d);
      onErr(d);
    });

    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killProcessTree(child);
        }, opts.timeoutMs)
      : undefined;

    const finish = (code: number): void => {
      if (timer) clearTimeout(timer);
      const done = (): void =>
        resolve({
          code: timedOut ? 124 : aborted !== undefined ? 125 : code,
          durationMs: Date.now() - start,
          timedOut,
          ...(aborted !== undefined && !timedOut ? { aborted } : {}),
        });
      if (!log) return done();
      // Resolve only once the log is flushed so callers never read a partial file.
      log.once("close", done);
      log.end();
    };

    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 0));

    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/**
 * Spawn a child that shares this process's terminal (`stdio: "inherit"`) so a
 * human interacts with it directly — used to hand control to an interactive
 * `claude` planning session. Nothing is captured and there is no timeout; the
 * human ends the session. Windows shell-quoting matches spawnLogged, so keep
 * argv values metachar-free (long text like a system prompt must be a single
 * line with no embedded double-quotes). Resolves with the child's exit code
 * (127 = failed to start).
 */
export function spawnInteractive(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean } = {},
): Promise<{ code: number }> {
  return new Promise((resolve) => {
    const useShell = opts.shell ?? false;
    let command = cmd;
    let spawnArgs = args;
    if (useShell && args.length) {
      const q = (s: string): string => (/\s/.test(s) ? `"${s}"` : s);
      command = [cmd, ...args].map(q).join(" ");
      spawnArgs = [];
    }
    const child = spawn(command, spawnArgs, {
      cwd: opts.cwd,
      shell: useShell,
      env: opts.env ?? process.env,
      stdio: "inherit",
    });
    child.on("error", () => resolve({ code: 127 }));
    child.on("close", (code) => resolve({ code: code ?? 0 }));
  });
}
