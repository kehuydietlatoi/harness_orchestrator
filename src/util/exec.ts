import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

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
 * Run a subprocess without a shell (avoids injection / quoting issues).
 * Never rejects — failures come back as a non-zero `code`.
 */
export function exec(
  cmd: string,
  args: string[] = [],
  opts: { cwd?: string; input?: string; maxBuffer?: number } = {},
): Promise<ExecResult> {
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, shell: false });
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
        child.kill();
        return false;
      }
      return true;
    };

    child.stdout.on("data", (d: Buffer) => {
      if (accept(d)) stdout += outDecoder.write(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      if (accept(d)) stderr += errDecoder.write(d);
    });
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: stderr + String(err) }));
    child.on("close", (code) => {
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
      resolve({ code: code ?? 0, stdout, stderr });
    });
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/** True if `cmd` is resolvable on PATH. */
export async function commandExists(cmd: string): Promise<boolean> {
  const isWin = process.platform === "win32";
  // Pass cmd as a positional arg ($1), never interpolated into the script, so a
  // command name can never break out of the `command -v` invocation.
  const res = isWin
    ? await exec("where", [cmd])
    : await exec("sh", ["-c", 'command -v "$1"', "sh", cmd]);
  return res.code === 0;
}
