export interface RunContext {
  issue: number;
  agent: string;
  worktree: string; // becomes the child process cwd
  prompt: string; // delivered on stdin
  model?: string; // resolved agent-specific model value
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

/** A prompt run used by the planner and routing judge. */
export interface HeadlessContext {
  cwd: string;
  prompt: string;
  model?: string;
  logFile: string;
  timeoutMs?: number;
}

export interface HeadlessResult {
  code: number;
  timedOut: boolean;
  /** Final assistant text reduced from the adapter's structured output. */
  text: string;
  /** Full structured log, surfaced in fail-closed error messages. */
  raw: string;
}

export interface InteractivePlanContext {
  cwd: string;
  seed: string;
  model?: string;
}

export interface InteractivePlanResult {
  code: number;
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
  /** Run a structured prompt for planner/judge use. Optional adapter capability. */
  runHeadless?(ctx: HeadlessContext): Promise<HeadlessResult>;
  /** Hand an interactive planning session to the human. Optional adapter capability. */
  runInteractivePlan?(ctx: InteractivePlanContext): Promise<InteractivePlanResult>;
}
