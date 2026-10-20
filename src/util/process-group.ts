import { execFileSync, spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";

let launcher: string | undefined;

/** Compile once per coordinator, into an exclusively owned directory. No addon or shell. */
function runLauncher(): string {
  if (launcher) return launcher;
  const dir = mkdtempSync(join(tmpdir(), "orch-launcher-"));
  const windows = process.platform === "win32";
  const source = fileURLToPath(new URL(`../../assets/process-run.${windows ? "cs" : "c"}`, import.meta.url));
  const target = join(dir, windows ? "run.exe" : "run");
  try {
    if (windows) {
      execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
        ["/nologo", "/target:exe", `/out:${target}`, source], { windowsHide: true });
    } else {
      execFileSync("cc", ["-O2", "-o", target, source]);
    }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Cannot establish run process containment: ${String(error)}`);
  }
  launcher = target;
  process.once("exit", () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* OS may still hold the executable */ }
  });
  return target;
}

const runs = new WeakMap<ChildProcess, () => void>();

/** The supervisor must survive cancellation so it can drain and reap its run. */
export function stopRun(child: ChildProcess): boolean {
  const stop = runs.get(child);
  if (!stop) return false;
  stop();
  return true;
}

export function spawnRun(command: string, args: string[], options: SpawnOptionsWithoutStdio): ChildProcess {
  const executable = runLauncher();
  const control = mkdtempSync(join(tmpdir(), "orch-run-"));
  // Shell use remains an explicit caller choice; argv never passes through a shell otherwise.
  if (options.shell) {
    if (process.platform === "win32") {
      args = ["/d", "/s", "/c", `"${command}"`];
      command = process.env.ComSpec ?? "cmd.exe";
    } else {
      args = ["-c", command];
      command = "/bin/sh";
    }
  }
  // The supervisor receives normal CRT argv and reconstructs cmd's raw /c
  // payload itself. Verbatim arguments belong only on a direct cmd spawn.
  const child = spawn(executable, [control, command, ...args], { ...options, shell: false, windowsHide: true, windowsVerbatimArguments: false });
  child.once("close", () => {
    try { rmSync(control, { recursive: true, force: true }); }
    catch (error) { log.warn(`Could not remove run control directory ${control}: ${String(error)}`); }
  });
  const stop = (): void => {
    try { writeFileSync(join(control, "stop"), ""); }
    catch (error) { log.warn(`Could not stop run ${command} (owner PID ${child.pid}): ${String(error)}`); }
  };
  let pending = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    const lines = (pending + chunk.toString("utf8")).split(/\r?\n/);
    pending = lines.pop()!.slice(-4096);
    for (const line of lines) if (line.startsWith("[process-run] WARNING:")) log.warn(line);
  });
  runs.set(child, stop);
  return child;
}
