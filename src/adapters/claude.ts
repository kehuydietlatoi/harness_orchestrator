import { commandExists } from "../util/exec.js";
import { spawnInteractive, spawnLogged } from "../util/spawn.js";
import type { AdapterConfig } from "../config.js";
import { runStructuredHeadless } from "./headless.js";
import type {
  HarnessAdapter,
  HeadlessContext,
  HeadlessResult,
  InteractivePlanContext,
  InteractivePlanResult,
  RunContext,
  ReviewContext,
  RunResult,
} from "./types.js";

const WIN = process.platform === "win32";

export function buildClaudeTaskArgs(model?: string): string[] {
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
  if (model !== undefined) args.push("--model", model);
  return args;
}

/** Reduce Claude stream-json output to the final result text. Pure. */
export function resultTextFromClaudeStreamJson(logText: string): string {
  let result = "";
  for (const line of logText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj.type === "result" && typeof obj.result === "string") result = obj.result;
    } catch {
      // Ignore non-JSON lines and partial output; only a final result is usable.
    }
  }
  return result;
}

/** Build Claude argv for an interactive planning session. Pure. */
export function buildClaudeInteractivePlanArgs(model: string | undefined, seed: string): string[] {
  const args = ["--append-system-prompt", seed, "--allowedTools", "Read", "Grep", "Glob", "Write"];
  if (model !== undefined) args.push("--model", model);
  return args;
}

/** Drives Claude Code in headless (`-p`) mode. */
export class ClaudeAdapter implements HarnessAdapter {
  readonly id = "claude";
  constructor(private readonly cfg: AdapterConfig) {}

  healthCheck(): Promise<boolean> {
    return commandExists(this.cfg.cmd);
  }

  async runTask(ctx: RunContext): Promise<RunResult> {
    // Prompt on stdin; worktree as cwd. allowedTools kept metachar-free for the shell.
    const args = buildClaudeTaskArgs(ctx.model);
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

  runHeadless(ctx: HeadlessContext): Promise<HeadlessResult> {
    return runStructuredHeadless(this.cfg.cmd, buildClaudeTaskArgs(ctx.model), ctx, resultTextFromClaudeStreamJson);
  }

  runInteractivePlan(ctx: InteractivePlanContext): Promise<InteractivePlanResult> {
    return spawnInteractive(this.cfg.cmd, buildClaudeInteractivePlanArgs(ctx.model, ctx.seed), {
      cwd: ctx.cwd,
      shell: WIN,
    });
  }
}
