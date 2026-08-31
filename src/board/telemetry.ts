import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { log } from "../util/log.js";

export interface RunRecord {
  ts: string;
  project: string;
  issue: number;
  agent: string;
  /** Resolved model/effort tier the run used (e.g. "opus", "high"); null when unknown. */
  model: string | null;
  outcome: string;
  durationMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensTotal: number | null;
  costUsd: number | null;
}

export interface RunUsage {
  tokensIn: number | null;
  tokensOut: number | null;
  tokensTotal: number | null;
  /** Portion of tokensIn served from the prompt cache (cheaper); null when unknown. */
  cachedInputTokens: number | null;
  costUsd: number | null;
}

type JsonObject = Record<string, unknown>;

const INPUT_KEYS = ["input_tokens", "inputTokens", "tokens_in", "tokensIn", "prompt_tokens", "promptTokens"];
const OUTPUT_KEYS = [
  "output_tokens",
  "outputTokens",
  "tokens_out",
  "tokensOut",
  "completion_tokens",
  "completionTokens",
];
const TOTAL_KEYS = ["total_tokens", "totalTokens", "tokens_total", "tokensTotal"];
const COST_KEYS = ["total_cost_usd", "totalCostUsd", "cost_usd", "costUsd"];
const CACHED_KEYS = ["cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens", "cacheReadInputTokens"];

function emptyUsage(): RunUsage {
  return { tokensIn: null, tokensOut: null, tokensTotal: null, cachedInputTokens: null, costUsd: null };
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function numericField(obj: JsonObject, keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function usageFromObject(obj: JsonObject): RunUsage {
  const tokensIn = numericField(obj, INPUT_KEYS);
  const tokensOut = numericField(obj, OUTPUT_KEYS);
  const explicitTotal = numericField(obj, TOTAL_KEYS);
  return {
    tokensIn,
    tokensOut,
    tokensTotal: explicitTotal ?? (tokensIn !== null && tokensOut !== null ? tokensIn + tokensOut : null),
    cachedInputTokens: numericField(obj, CACHED_KEYS),
    costUsd: numericField(obj, COST_KEYS),
  };
}

function hasUsage(usage: RunUsage): boolean {
  return Object.values(usage).some((value) => value !== null);
}

function parseClaudeResult(obj: JsonObject): RunUsage | null {
  if (obj.type !== "result") return null;

  const usageObj = objectValue(obj.usage);
  const usage = usageObj ? usageFromObject(usageObj) : emptyUsage();
  if (usageObj) {
    const cacheRead = numericField(usageObj, ["cache_read_input_tokens", "cacheReadInputTokens"]);
    const cacheCreation = numericField(usageObj, ["cache_creation_input_tokens", "cacheCreationInputTokens"]);
    const inputParts = [usage.tokensIn, cacheRead, cacheCreation].filter((value): value is number => value !== null);
    usage.tokensIn = inputParts.length > 0 ? inputParts.reduce((sum, value) => sum + value, 0) : null;
    if (numericField(usageObj, TOTAL_KEYS) === null) {
      usage.tokensTotal = usage.tokensIn !== null && usage.tokensOut !== null ? usage.tokensIn + usage.tokensOut : null;
    }
  }
  usage.costUsd = numericField(obj, COST_KEYS) ?? usage.costUsd;
  return usage;
}

interface UsageCandidate {
  usage: RunUsage;
  score: number;
}

function codexCandidate(value: unknown, path: string[] = [], depth = 0): UsageCandidate | null {
  if (depth > 8) return null;
  const obj = objectValue(value);
  if (!obj) return null;

  let best: UsageCandidate | null = null;
  const direct = usageFromObject(obj);
  if (hasUsage(direct)) {
    const key = path.at(-1);
    const pathBonus = key === "total_token_usage" || key === "totalTokenUsage" ? 100 : key === "usage" ? 50 : 0;
    const populated = Object.values(direct).filter((part) => part !== null).length;
    best = { usage: direct, score: pathBonus + populated };
  }

  for (const [key, child] of Object.entries(obj)) {
    if (typeof child !== "object" || child === null) continue;
    const candidate = codexCandidate(child, [...path, key], depth + 1);
    if (candidate && candidate.usage.costUsd === null && direct.costUsd !== null) {
      candidate.usage.costUsd = direct.costUsd;
    }
    if (candidate && (!best || candidate.score > best.score)) best = candidate;
  }
  return best;
}

function parseLine(line: string): JsonObject | null {
  try {
    return objectValue(JSON.parse(line) as unknown);
  } catch {
    return null;
  }
}

/** Extract cumulative usage from Claude stream-json or Codex JSONL output. */
export function parseUsage(logText: string, agent: string): RunUsage {
  try {
    const normalizedAgent = agent.toLowerCase();
    let latest = emptyUsage();

    for (const line of logText.split(/\r?\n/)) {
      const parsed = parseLine(line.trim());
      if (!parsed) continue;

      if (normalizedAgent === "claude") {
        const usage = parseClaudeResult(parsed);
        if (usage) latest = usage;
        continue;
      }

      if (normalizedAgent === "codex") {
        const candidate = codexCandidate(parsed);
        if (candidate) latest = candidate.usage;
        continue;
      }

      const claudeUsage = parseClaudeResult(parsed);
      const codexUsage = codexCandidate(parsed)?.usage ?? null;
      if (claudeUsage) latest = claudeUsage;
      else if (codexUsage) latest = codexUsage;
    }
    return latest;
  } catch {
    return emptyUsage();
  }
}

/** Stable project key: repository-root basename, falling back to cwd basename. */
export function projectId(cwd: string): string {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) return basename(root);
  } catch {
    // A non-git directory (or unavailable git) uses the cwd basename.
  }
  return basename(resolve(cwd));
}

export function telemetryPath(cwd: string): string {
  return join(homedir(), ".orch", projectId(cwd), "runs.jsonl");
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseRunRecord(value: unknown): RunRecord | null {
  const obj = objectValue(value);
  if (
    !obj ||
    typeof obj.ts !== "string" ||
    typeof obj.project !== "string" ||
    !Number.isInteger(obj.issue) ||
    typeof obj.agent !== "string" ||
    typeof obj.outcome !== "string" ||
    nullableNumber(obj.durationMs) === null
  ) {
    return null;
  }

  return {
    ts: obj.ts,
    project: obj.project,
    issue: obj.issue as number,
    agent: obj.agent,
    // Older records predate the model field — treat as unknown rather than dropping the row.
    model: typeof obj.model === "string" ? obj.model : null,
    outcome: obj.outcome,
    durationMs: obj.durationMs as number,
    tokensIn: nullableNumber(obj.tokensIn),
    tokensOut: nullableNumber(obj.tokensOut),
    tokensTotal: nullableNumber(obj.tokensTotal),
    costUsd: nullableNumber(obj.costUsd),
  };
}

/** Read valid JSONL run records. Missing/malformed telemetry is always non-fatal. */
export function readRuns(cwd: string): RunRecord[] {
  try {
    const records: RunRecord[] = [];
    for (const line of readFileSync(telemetryPath(cwd), "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = parseRunRecord(JSON.parse(line) as unknown);
        if (record) records.push(record);
      } catch {
        // A malformed telemetry line must not affect the caller's outcome.
      }
    }
    return records;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`could not read run telemetry: ${message}`);
    return [];
  }
}

/** Append best-effort telemetry without ever affecting the task outcome. */
export function appendRun(rec: RunRecord, cwd: string): void {
  try {
    const path = telemetryPath(cwd);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(rec)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`could not append run telemetry: ${message}`);
  }
}
