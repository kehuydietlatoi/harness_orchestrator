import { commandExists } from "../util/exec.js";
import { spawnLogged } from "../util/spawn.js";
import type { AdapterConfig } from "../config.js";
import type { HarnessAdapter, RunContext, ReviewContext, RunResult } from "./types.js";

const WIN = process.platform === "win32";

/** Drives Claude Code in headless (`-p`) mode. */
export class ClaudeAdapter implements HarnessAdapter {
  readonly id = "claude";
  constructor(private readonly cfg: AdapterConfig) {}

  healthCheck(): Promise<boolean> {
    return commandExists(this.cfg.cmd);
  }

  async runTask(ctx: RunContext): Promise<RunResult> {
    // Prompt on stdin; worktree as cwd. allowedTools kept metachar-free for the shell.
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Read,Edit,Write,Bash",
    ];
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
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Read,Bash",
    ];
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
