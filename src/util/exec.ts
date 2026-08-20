import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a subprocess without a shell (avoids injection / quoting issues).
 * Never rejects — failures come back as a non-zero `code`.
 */
export function exec(
  cmd: string,
  args: string[] = [],
  opts: { cwd?: string; input?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: stderr + String(err) }));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/** True if `cmd` is resolvable on PATH. */
export async function commandExists(cmd: string): Promise<boolean> {
  const isWin = process.platform === "win32";
  const res = isWin
    ? await exec("where", [cmd])
    : await exec("sh", ["-c", `command -v ${cmd}`]);
  return res.code === 0;
}
