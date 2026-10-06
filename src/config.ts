import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_PRICING, type ModelPricing } from "./board/pricing.js";

/** What an adapter is told to run for one effort tier. Either field may be omitted
 * to defer to the harness's own configured default (e.g. `~/.codex/config.toml`). */
export interface ModelSpec {
  /** Harness-specific model id or alias (`claude-sonnet-5-5`, a Codex model id). */
  model?: string;
  /** Reasoning/thinking effort handed to the harness (`low|medium|high|xhigh|max`). */
  effort?: string;
}

export type EffortTier = "easy" | "hard";

/** Who may review a PR: `cross` = only the other harness; `cross-or-self` additionally
 * lets the author's harness review in a fresh session while every other harness is
 * unavailable (usage limit), so one exhausted harness cannot block the other. */
export type ReviewPolicy = "cross" | "cross-or-self";

export interface AdapterConfig {
  cmd: string;
  models?: Record<EffortTier, ModelSpec>;
}

/** Render a spec for telemetry/logs as `model@effort` (either half may be absent). */
export function formatModelSpec(spec: ModelSpec | undefined): string | undefined {
  if (!spec || (!spec.model && !spec.effort)) return undefined;
  return [spec.model ?? "default", spec.effort].filter(Boolean).join("@");
}

/**
 * Accept a configured tier value. Before `ModelSpec` the tier was a bare string whose
 * meaning was adapter-specific: Codex's string was a reasoning effort, every other
 * adapter's was a model. Keep reading those configs rather than breaking them.
 */
function normalizeModelSpec(agent: string, value: unknown): ModelSpec | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return agent === "codex" ? { effort: value } : { model: value };
  if (typeof value === "object") {
    const { model, effort } = value as ModelSpec;
    return {
      ...(typeof model === "string" ? { model } : {}),
      ...(typeof effort === "string" ? { effort } : {}),
    };
  }
  throw new Error(`adapters.${agent}.models entries must be a string or { model, effort }`);
}

export interface OrchConfig {
  agents: string[];
  lead: string;
  /** GitHub branch name used as the base for task branches and pull requests.
   * When omitted, orch asks GitHub for the repository default branch. */
  baseBranch?: string;
  requireCrossReview: boolean;
  reviewPolicy: ReviewPolicy;
  requireHumanMerge: boolean;
  worktreeRoot: string;
  maxConcurrent: number;
  taskTimeoutMs: number;
  defaultEffort?: "easy" | "hard";
  adapters: Record<string, AdapterConfig>;
  /** Per-million-token USD rates keyed by resolved model string, for computing a
   * cost fallback when a harness log reports none. Subscription-billed agents
   * (e.g. Codex) simply have no entry, so their cost stays null. */
  pricing: Record<string, ModelPricing>;
}

export const CONFIG_FILE = "orch.config.json";

export const DEFAULT_CONFIG: OrchConfig = {
  agents: ["claude", "codex"],
  lead: "claude",
  requireCrossReview: true,
  reviewPolicy: "cross-or-self",
  requireHumanMerge: false,
  worktreeRoot: "../wt",
  maxConcurrent: 2,
  taskTimeoutMs: 1_800_000, // 30 minutes
  defaultEffort: "hard",
  // Both tiers default to the same capable model at medium effort; set `models.hard`
  // (and `effort:` labels) to opt individual tasks into something stronger. Codex pins
  // its model explicitly so a user's ~/.codex/config.toml default never changes cost.
  adapters: {
    claude: {
      cmd: "claude",
      models: {
        easy: { model: "claude-sonnet-5-5", effort: "medium" },
        hard: { model: "claude-sonnet-5-5", effort: "medium" },
      },
    },
    codex: {
      cmd: "codex",
      models: {
        easy: { model: "gpt-6.1-sol", effort: "medium" },
        hard: { model: "gpt-6.1-sol", effort: "medium" },
      },
    },
  },
  pricing: DEFAULT_PRICING,
};

export function configPath(cwd: string = process.cwd()): string {
  return resolve(cwd, CONFIG_FILE);
}

export function configExists(cwd: string = process.cwd()): boolean {
  return existsSync(configPath(cwd));
}

export function loadConfig(cwd: string = process.cwd()): OrchConfig {
  const p = configPath(cwd);
  if (!existsSync(p)) {
    throw new Error(`No ${CONFIG_FILE} found in ${cwd}. Run \`orch init\` first.`);
  }
  const text = readFileSync(p, "utf8").replace(/^\uFEFF/, ""); // tolerate a UTF-8 BOM
  const raw = JSON.parse(text) as Partial<OrchConfig>;
  if (
    Object.prototype.hasOwnProperty.call(raw, "baseBranch") &&
    (typeof raw.baseBranch !== "string" || raw.baseBranch.trim().length === 0)
  ) {
    throw new Error("baseBranch must be a non-empty string when configured");
  }
  if (
    Object.prototype.hasOwnProperty.call(raw, "reviewPolicy") &&
    raw.reviewPolicy !== "cross" &&
    raw.reviewPolicy !== "cross-or-self"
  ) {
    throw new Error('reviewPolicy must be "cross" or "cross-or-self"');
  }
  const adapters = { ...DEFAULT_CONFIG.adapters };
  for (const [agent, override] of Object.entries(raw.adapters ?? {})) {
    const defaults = DEFAULT_CONFIG.adapters[agent];
    const merged = { ...defaults, ...override };
    if (defaults?.models || override.models) {
      // Merge per tier so `{ hard: { effort: "high" } }` keeps the default model.
      const models: Partial<Record<EffortTier, ModelSpec>> = {};
      for (const tier of ["easy", "hard"] as const) {
        const spec = {
          ...defaults?.models?.[tier],
          ...normalizeModelSpec(agent, (override.models as Record<string, unknown> | undefined)?.[tier]),
        };
        if (Object.keys(spec).length > 0) models[tier] = spec;
      }
      merged.models = models as Record<EffortTier, ModelSpec>;
    }
    adapters[agent] = merged;
  }
  // Merge pricing so a config that sets only some models keeps the built-in
  // defaults for the rest (self-heals like the label set does).
  const pricing = { ...DEFAULT_CONFIG.pricing, ...raw.pricing };
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    adapters,
    pricing,
  };
}
