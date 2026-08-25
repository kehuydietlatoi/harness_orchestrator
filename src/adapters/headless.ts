import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildClaudeTaskArgs } from "./claude.js";
import type { OrchConfig } from "../config.js";
import { spawnLogged } from "../util/spawn.js";

const WIN = process.platform === "win32";
const RAW_LIMIT = 4000;

export interface HeadlessResult {
  code: number;
  timedOut: boolean;
  /** Final assistant text (already reduced from stream-json), used for extraction. */
  text: string;
  /** Full raw log, surfaced in error messages. */
  raw: string;
}

/** Clip long raw output for error messages. Pure. */
export function truncate(text: string): string {
  return text.length > RAW_LIMIT ? `${text.slice(0, RAW_LIMIT)}… (truncated)` : text;
}

/** Reduce Claude stream-json log output to its final `result` text. Pure. */
export function resultTextFromStreamJson(logText: string): string {
  let result = "";
  for (const line of logText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj.type === "result" && typeof obj.result === "string") result = obj.result;
    } catch {
      // Non-JSON lines (or partial output) are ignored; we want the final result.
    }
  }
  return result;
}

/** Pull the payload from the last fenced code block (json-tagged preferred). Pure. */
export function lastFencedBlock(text: string): string | null {
  const tagged = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const any = tagged.length > 0 ? tagged : [...text.matchAll(/```\s*([\s\S]*?)```/g)];
  const last = any.at(-1);
  return last ? last[1].trim() : null;
}

/**
 * Run the lead harness headless with `prompt` on stdin, capturing its stream-json
 * output to `logs/<logName>.jsonl` and reducing it to the final result text.
 *
 * This is the single spawn boundary shared by the routing judge and the planner.
 * Each caller wraps it in its own injectable runner type (`JudgeRunner` /
 * `PlannerRunner`) so tests can substitute a canned reply and never launch a real
 * `claude`. A missing log leaves `raw` empty, and the caller then fails closed.
 */
export async function runHeadlessAgent(
  prompt: string,
  model: string | undefined,
  cfg: OrchConfig,
  cwd: string,
  logName: string,
): Promise<HeadlessResult> {
  const adapter = cfg.adapters[cfg.lead];
  if (!adapter) throw new Error(`no adapter configured for lead '${cfg.lead}'`);
  const logFile = resolve(cwd, "logs", `${logName}.jsonl`);
  mkdirSync(dirname(logFile), { recursive: true });
  rmSync(logFile, { force: true }); // start clean so we read only this run's output
  const r = await spawnLogged(adapter.cmd, buildClaudeTaskArgs(model), {
    cwd,
    input: prompt,
    logFile,
    timeoutMs: cfg.taskTimeoutMs,
    shell: WIN,
  });
  let raw = "";
  try {
    raw = readFileSync(logFile, "utf8");
  } catch {
    // A missing log leaves raw empty; the caller fails closed on the empty result.
  }
  return { code: r.code, timedOut: r.timedOut, text: resultTextFromStreamJson(raw), raw };
}
