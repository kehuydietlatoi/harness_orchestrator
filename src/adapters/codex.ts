import { logSize, readLogSince } from "../util/log-file.js";
import { commandExists } from "../util/exec.js";
import { spawnLogged } from "../util/spawn.js";
import type { AdapterConfig, ModelSpec } from "../config.js";
import { runStructuredHeadless } from "./headless.js";
import type {
  HarnessAdapter,
  HeadlessContext,
  HeadlessResult,
  RunContext,
  RunResult,
} from "./types.js";

const WIN = process.platform === "win32";

/**
 * Codex argv for a task run. With `resumeSession`, the exec options stay in front of the
 * `resume` subcommand (verified against codex-cli 0.160) and the prompt is read from stdin (`-`).
 */
export function buildCodexTaskArgs(spec?: ModelSpec, resumeSession?: string): string[] {
  const args = ["exec", "--approve-for-me", "--json"];
  if (spec?.model !== undefined) args.push("-m", spec.model);
  if (spec?.effort !== undefined) args.push("-c", `model_reasoning_effort=${spec.effort}`);
  if (resumeSession) args.push("resume", resumeSession, "-");
  return args;
}

/** The newest conversation id announced in a Codex `exec --json` log (`thread.started`). Pure. */
export function sessionIdFromCodexJson(logText: string): string | undefined {
  let id: string | undefined;
  for (const line of logText.split(/\r?\n/)) {
    if (!line.includes("thread.started")) continue;
    try {
      const event = JSON.parse(line.trim()) as Record<string, unknown>;
      if (event.type === "thread.started" && typeof event.thread_id === "string") id = event.thread_id;
    } catch {
      // not a JSON line
    }
  }
  return id;
}

/** Codex argv for a read-only reviewer session: the read-only sandbox, no auto-approval. Pure. */
export function buildCodexReviewArgs(spec?: ModelSpec): string[] {
  const args = ["exec", "--json", "-s", "read-only"];
  if (spec?.model !== undefined) args.push("-m", spec.model);
  if (spec?.effort !== undefined) args.push("-c", `model_reasoning_effort=${spec.effort}`);
  return args;
}

/** Reduce Codex `exec --json` events to the final completed agent message. Pure. */
export function resultTextFromCodexJson(logText: string): string {
  let result = "";
  for (const line of logText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (event.type !== "item.completed" || !event.item || typeof event.item !== "object") continue;
      const item = event.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") result = item.text;
    } catch {
      // Ignore non-JSON lines and partial output; only completed messages are usable.
    }
  }
  return result;
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
    const args = buildCodexTaskArgs(ctx.model, ctx.resumeSession);
    const logMark = ctx.logFile ? logSize(ctx.logFile) : 0; // the log is shared by every retry
    const r = await spawnLogged(this.cfg.cmd, args, {
      cwd: ctx.worktree,
      input: ctx.prompt,
      logFile: ctx.logFile,
      timeoutMs: ctx.timeoutMs,
      shell: WIN,
    });
    // Codex picks its own thread id, so read it back from what this run appended. A run that failed
    // before announcing one must not inherit an older run's id from the shared log.
    const sessionId =
      (ctx.logFile ? sessionIdFromCodexJson(readLogSince(ctx.logFile, logMark)) : undefined) ?? ctx.resumeSession;
    return {
      ok: r.code === 0,
      code: r.code,
      durationMs: r.durationMs,
      timedOut: r.timedOut,
      logFile: ctx.logFile,
      sessionId,
    };
  }

  runHeadless(ctx: HeadlessContext): Promise<HeadlessResult> {
    const args = ctx.readOnly ? buildCodexReviewArgs(ctx.model) : buildCodexTaskArgs(ctx.model);
    return runStructuredHeadless(this.cfg.cmd, args, ctx, resultTextFromCodexJson);
  }
}
