import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnLogged } from "../util/spawn.js";
import type { HarnessAdapter, HeadlessContext, HeadlessResult } from "./types.js";

const WIN = process.platform === "win32";
const RAW_LIMIT = 4000;

/** Clip long raw output for error messages. Pure. */
export function truncate(text: string): string {
  return text.length > RAW_LIMIT ? `${text.slice(0, RAW_LIMIT)}… (truncated)` : text;
}

/** Pull the payload from the last fenced code block (json-tagged preferred). Pure. */
export function lastFencedBlock(text: string): string | null {
  const tagged = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const any = tagged.length > 0 ? tagged : [...text.matchAll(/```\s*([\s\S]*?)```/g)];
  const last = any.at(-1);
  return last ? last[1].trim() : null;
}

/**
 * Spawn one adapter-owned structured headless command and reduce its log with
 * that adapter's parser. This keeps logging/timeout mechanics shared without
 * teaching the shared module any harness-specific arguments or event shapes.
 */
export async function runStructuredHeadless(
  cmd: string,
  args: string[],
  ctx: HeadlessContext,
  resultText: (raw: string) => string,
): Promise<HeadlessResult> {
  mkdirSync(dirname(ctx.logFile), { recursive: true });
  rmSync(ctx.logFile, { force: true });
  const r = await spawnLogged(cmd, args, {
    cwd: ctx.cwd,
    input: ctx.prompt,
    logFile: ctx.logFile,
    timeoutMs: ctx.timeoutMs,
    shell: WIN,
  });
  let raw = "";
  try {
    raw = readFileSync(ctx.logFile, "utf8");
  } catch {
    // A missing log leaves raw empty; the planner/judge fails closed.
  }
  return { code: r.code, timedOut: r.timedOut, text: resultText(raw), raw };
}

/**
 * Run the configured lead's planner/judge capability with `prompt` on stdin,
 * capturing structured output to `logs/<logName>.jsonl`.
 *
 * This is the single spawn boundary shared by the routing judge and the planner.
 * Each caller wraps it in its own injectable runner type (`JudgeRunner` /
 * `PlannerRunner`) so tests can substitute a canned reply and never launch a real
 * harness. Unsupported adapters fail before any process is launched.
 */
export async function runHeadlessAgent(
  adapter: HarnessAdapter,
  prompt: string,
  model: string | undefined,
  cwd: string,
  logName: string,
  timeoutMs?: number,
): Promise<HeadlessResult> {
  if (!adapter.runHeadless) {
    throw new Error(`lead adapter '${adapter.id}' does not support planner/judge execution`);
  }
  const logFile = resolve(cwd, "logs", `${logName}.jsonl`);
  return adapter.runHeadless({
    cwd,
    prompt,
    model,
    logFile,
    timeoutMs,
  });
}

export type { HeadlessResult } from "./types.js";
