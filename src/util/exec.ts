import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { killProcessTree } from "./spawn.js";
import { spawnRun } from "./process-group.js";
import { log } from "./log.js";
import { resolveWindowsCommand, windowsInvocation } from "./win-command.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Cap on combined stdout+stderr a single subprocess may buffer (64 MiB). Large
 * but bounded: it comfortably fits any `gh` JSON page or `git`/`gh` diff we read
 * while stopping a runaway child from exhausting memory. On overflow the child
 * is killed and the call fails loudly (non-zero code) rather than silently
 * returning truncated output that a parser would misread.
 */
export const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Run literal argv with shell:false. Windows batch shims use an explicitly
 * escaped cmd.exe launch plan; native executables and POSIX argv stay direct.
 * Never rejects — failures come back as a non-zero `code`.
 */
export function exec(
  cmd: string,
  args: string[] = [],
  opts: { cwd?: string; input?: string; maxBuffer?: number; timeoutMs?: number; env?: NodeJS.ProcessEnv;
    /** Commands executing project code must drain all descendants before returning. */
    contain?: boolean } = {},
): Promise<ExecResult> {
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      const invocation = process.platform === "win32"
        ? windowsInvocation(resolveWindowsCommand(cmd, opts.cwd ?? process.cwd(), opts.env ?? process.env), args, opts.env ?? process.env)
        : { command: cmd, args, env: opts.env };
      const options = { cwd: opts.cwd, shell: false,
        ...(invocation.env ? { env: invocation.env } : {}),
        ...("windowsVerbatimArguments" in invocation ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments } : {}) };
      child = opts.contain ? spawnRun(invocation.command, invocation.args, options) : spawn(invocation.command, invocation.args, options);
    } catch (error) {
      log.warn(`${cmd}: ${String(error)}`);
      resolve({ code: 127, stdout: "", stderr: String(error) });
      return;
    }
    const stop = (): void => killProcessTree(child);
    let timedOut = false;
    const timer = opts.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs);
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let overflowed = false;
    // Decode via StringDecoder so a multi-byte UTF-8 character split across two
    // stream chunks (chunks break at the ~64 KiB highWaterMark, not char
    // boundaries) is reassembled rather than turned into U+FFFD — otherwise a
    // large `gh api` JSON page with emoji/accents/CJK could corrupt or fail to
    // parse. One decoder per stream since they carry independent partial state.
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");

    // Count raw bytes across both streams; once the cap is hit, stop buffering
    // and kill the child so a runaway process can't grow this unboundedly.
    const accept = (chunk: Buffer): boolean => {
      if (overflowed) return false;
      bytes += chunk.length;
      if (bytes > maxBuffer) {
        overflowed = true;
        stop();
        return false;
      }
      return true;
    };

    child.stdout?.on("data", (d: Buffer) => {
      if (accept(d)) stdout += outDecoder.write(d);
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (accept(d)) stderr += errDecoder.write(d);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Flush any bytes the decoders are still holding (a valid stream leaves
      // nothing pending; a truncated one emits the trailing replacement char).
      if (!overflowed) {
        stdout += outDecoder.end();
        stderr += errDecoder.end();
      }
      if (overflowed) {
        resolve({
          code: code && code !== 0 ? code : 1,
          stdout,
          stderr: `${stderr}\n[exec] output exceeded maxBuffer (${maxBuffer} bytes); process killed`,
        });
        return;
      }
      if (timedOut) {
        resolve({ code: 124, stdout, stderr: `${stderr}\n[exec] timed out after ${opts.timeoutMs}ms` });
        return;
      }
      resolve({ code: code ?? 0, stdout, stderr });
    });
    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/** Validate the same launch plan as exec, without executing project code. */
export async function commandRunError(argv: readonly string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string | undefined> {
  try {
    if (process.platform === "win32") {
      const env = opts.env ?? process.env;
      windowsInvocation(resolveWindowsCommand(argv[0], opts.cwd ?? process.cwd(), env), argv.slice(1), env);
    } else if (!await commandExists(argv[0])) return `Command not found: ${argv[0]}`;
    return undefined;
  } catch (error) { return String(error); }
}

/** True if `cmd` is an executable absolute file path or resolvable on PATH. */
export async function commandExists(cmd: string): Promise<boolean> {
  // `where` rejects absolute paths. Check the exact file without executing it;
  // X_OK also enforces execute permission on POSIX (existence on Windows).
  if (isAbsolute(cmd)) {
    try {
      await access(cmd, constants.X_OK);
      return (await stat(cmd)).isFile();
    } catch {
      return false;
    }
  }
  const isWin = process.platform === "win32";
  // Pass cmd as a positional arg ($1), never interpolated into the script, so a
  // command name can never break out of the `command -v` invocation.
  const res = isWin
    ? await exec("where", [cmd])
    : await exec("sh", ["-c", 'command -v "$1"', "sh", cmd]);
  return res.code === 0;
}
