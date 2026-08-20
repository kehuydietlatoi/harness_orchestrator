import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export interface SpawnResult {
  code: number; // 124 = timed out, 127 = failed to start
  durationMs: number;
  timedOut: boolean;
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
    const onData = (d: Buffer): void => {
      if (log) log.write(d);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;

    const finish = (code: number): void => {
      if (timer) clearTimeout(timer);
      if (log) log.end();
      resolve({ code: timedOut ? 124 : code, durationMs: Date.now() - start, timedOut });
    };

    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 0));

    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}
