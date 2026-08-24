import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildClaudeTaskArgs } from "./adapters/claude.js";
import type { PlanEntry } from "./assign.js";
import type { OrchConfig } from "./config.js";
import { spawnLogged } from "./util/spawn.js";

const WIN = process.platform === "win32";
const RAW_LIMIT = 4000;

/** The judge's output contract, embedded verbatim in the prompt. */
const CONTRACT = [
  "Reply with EXACTLY ONE fenced code block tagged json and nothing after it:",
  "",
  "```json",
  '[{"issue": 12, "agent": "codex", "effort": "easy", "rationale": "one sentence"}]',
  "```",
  "",
  "Rules:",
  "- One array element per unassigned issue in the brief; skip nothing.",
  "- agent MUST be one of the configured agents shown in the telemetry section.",
  '- effort MUST be "easy" or "hard".',
  "  easy = mechanical, localized, well-specified work (cheaper model tier).",
  "  hard = ambiguous, cross-cutting, or design-heavy work (stronger model tier).",
  "- Choose the agent from the per-agent telemetry: prefer the one with the better",
  "  success rate / cost for that effort tier, and break ties toward load balancing.",
  "- rationale: one sentence grounded in the brief (scope and the telemetry you used).",
  "- Output ONLY the fenced json block. No prose before or after it.",
].join("\n");

/** Wrap a routing brief with the judge instructions and output contract. Pure. */
export function formatJudgePrompt(brief: string): string {
  return [
    "You are the routing judge for a dual-agent coding orchestrator.",
    "Read the routing brief below and decide, for every unassigned open issue,",
    "which agent should build it and at what effort tier.",
    "",
    "=== ROUTING BRIEF ===",
    brief,
    "=== END BRIEF ===",
    "",
    CONTRACT,
  ].join("\n");
}

function truncate(text: string): string {
  return text.length > RAW_LIMIT ? `${text.slice(0, RAW_LIMIT)}… (truncated)` : text;
}

/** Pull the JSON payload from the last fenced code block (json-tagged preferred). Pure. */
function lastFencedBlock(text: string): string | null {
  const tagged = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const any = tagged.length > 0 ? tagged : [...text.matchAll(/```\s*([\s\S]*?)```/g)];
  const last = any.at(-1);
  return last ? last[1].trim() : null;
}

/**
 * Extract a plan from the judge's reply text. Throws (fail-closed upstream) when
 * there is no fenced json block, it is not valid JSON, it is not an array, or an
 * entry lacks an integer `issue`. Agent/effort values are NOT validated here —
 * the writer's `applyPlan` reports those non-fatally. Pure.
 */
export function extractPlan(resultText: string): PlanEntry[] {
  const block = lastFencedBlock(resultText);
  if (block === null) throw new Error("no fenced ```json block found");

  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (e) {
    throw new Error(`fenced block is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("plan JSON must be an array");

  return parsed.map((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`plan entry ${i + 1} must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    if (!Number.isInteger(obj.issue)) {
      throw new Error(`plan entry ${i + 1} needs an integer issue number`);
    }
    return {
      issue: obj.issue as number,
      agent: typeof obj.agent === "string" ? obj.agent : String(obj.agent),
      effort: typeof obj.effort === "string" ? obj.effort : String(obj.effort),
      rationale: typeof obj.rationale === "string" ? obj.rationale : "",
    };
  });
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

export interface JudgeRun {
  code: number;
  timedOut: boolean;
  /** Final assistant text (already reduced from stream-json), used for extraction. */
  text: string;
  /** Full raw log, surfaced in error messages. */
  raw: string;
}

/** The spawn boundary — injectable so tests never launch a real `claude`. */
export type JudgeRunner = (
  prompt: string,
  model: string | undefined,
  cfg: OrchConfig,
  cwd: string,
) => Promise<JudgeRun>;

const defaultRunner: JudgeRunner = async (prompt, model, cfg, cwd) => {
  const adapter = cfg.adapters[cfg.lead];
  if (!adapter) throw new Error(`no adapter configured for lead '${cfg.lead}'`);
  const logFile = resolve(cwd, "logs", "judge.jsonl");
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
    // A missing log leaves raw empty; runJudge then fails closed below.
  }
  return { code: r.code, timedOut: r.timedOut, text: resultTextFromStreamJson(raw), raw };
};

/**
 * Run the judge headlessly at the lead's `hard` model and return a validated
 * plan. Fail-closed: a non-zero exit, timeout, empty output, unparseable reply,
 * or an empty plan all throw — the caller writes nothing.
 */
export async function runJudge(
  brief: string,
  cfg: OrchConfig,
  cwd: string,
  runner: JudgeRunner = defaultRunner,
): Promise<PlanEntry[]> {
  const model = cfg.adapters[cfg.lead]?.models?.hard;
  const res = await runner(formatJudgePrompt(brief), model, cfg, cwd);

  if (res.timedOut) throw new Error(`judge timed out after ${cfg.taskTimeoutMs}ms`);
  if (res.code !== 0) throw new Error(`judge exited ${res.code}\n--- output ---\n${truncate(res.raw)}`);

  const source = res.text || res.raw;
  let plan: PlanEntry[];
  try {
    plan = extractPlan(source);
  } catch (e) {
    throw new Error(`judge output not parseable: ${(e as Error).message}\n--- output ---\n${truncate(source)}`);
  }
  if (plan.length === 0) throw new Error(`judge produced an empty plan\n--- output ---\n${truncate(source)}`);
  return plan;
}
