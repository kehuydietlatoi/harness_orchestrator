import { commandExists } from "../util/exec.js";
import { spawnLogged } from "../util/spawn.js";
import type { AdapterConfig } from "../config.js";
import type { HarnessAdapter, RunContext, ReviewContext, RunResult } from "./types.js";

const WIN = process.platform === "win32";

export function buildCodexTaskArgs(model?: string): string[] {
  const args = ["exec", "--approve-for-me", "--json"];
  if (model !== undefined) args.push("-c", `model_reasoning_effort=${model}`);
  return args;
}

/** Drives Codex in headless (`codex exec`) mode. */
export class CodexAdapter implements HarnessAdapter {
  readonly id = "codex";
  constructor(private readonly cfg: AdapterConfig) {}

  healthCheck(): Promise<boolean> {
    return commandExists(this.cfg.cmd);
  }

  async runTask(ctx: RunContext): Promise<RunResult> {
    // cwd carries the worktree (no -C path in argv); prompt on stdin.
    // `--approve-for-me` = non-interactive, workspace-write sandbox (the modern
    // replacement for the removed `--full-auto`, codex-cli >= 0.14x).
    const args = buildCodexTaskArgs(ctx.model);
    const r = await spawnLogged(this.cfg.cmd, args, {
      cwd: ctx.worktree,
      input: ctx.prompt,
      logFile: ctx.logFile,
      timeoutMs: ctx.timeoutMs,
      shell: WIN,
    });
    return { ok: r.code === 0, code: r.code, durationMs: r.durationMs, timedOut: r.timedOut, logFile: ctx.logFile };
  }

  async runReview(ctx: ReviewContext): Promise<RunResult> {
    const args = ["exec", "--approve-for-me", "--json"];
    const r = await spawnLogged(this.cfg.cmd, args, {
      cwd: ctx.cwd,
      input: ctx.prompt,
      logFile: ctx.logFile,
      timeoutMs: ctx.timeoutMs,
      shell: WIN,
    });
    return { ok: r.code === 0, code: r.code, durationMs: r.durationMs, timedOut: r.timedOut, logFile: ctx.logFile };
  }
}
