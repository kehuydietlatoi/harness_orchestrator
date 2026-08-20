export interface RunContext {
  issue: number;
  agent: string;
  worktree: string; // becomes the child process cwd
  prompt: string; // delivered on stdin
  logFile?: string;
  timeoutMs?: number;
}

export interface ReviewContext {
  pr: number;
  agent: string;
  cwd: string; // where to run the review (repo or worktree)
  prompt: string;
  logFile?: string;
  timeoutMs?: number;
}

export interface RunResult {
  ok: boolean;
  code: number;
  durationMs: number;
  timedOut: boolean;
  logFile?: string;
}

/** A pluggable coding harness (claude, codex, …). Add one file per harness. */
export interface HarnessAdapter {
  readonly id: string;
  /** CLI installed and (best-effort) usable. */
  healthCheck(): Promise<boolean>;
  /** Run a task to completion in an isolated worktree. */
  runTask(ctx: RunContext): Promise<RunResult>;
  /** Review a PR (read-mostly). */
  runReview(ctx: ReviewContext): Promise<RunResult>;
}
