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

export const EFFORT_TIERS = ["free", "cheap", "standard", "lead"] as const;
export type EffortTier = typeof EFFORT_TIERS[number];
export type TierAliases = Partial<Record<"easy" | "hard", EffortTier>>;
export const DEFAULT_TIER_ALIASES = { easy: "standard", hard: "lead" } as const;

/** Canonical names resolve directly; legacy aliases are configurable. */
export function normalizeEffort(value: unknown, aliases: TierAliases = {}): EffortTier | undefined {
  if (value === "easy" || value === "hard") return aliases[value] ?? DEFAULT_TIER_ALIASES[value];
  return EFFORT_TIERS.includes(value as EffortTier) ? value as EffortTier : undefined;
}

export function raiseEffort(tier: EffortTier): EffortTier {
  return EFFORT_TIERS[Math.min(EFFORT_TIERS.indexOf(tier) + 1, EFFORT_TIERS.length - 1)];
}

/** Who may review a PR: `cross` = only the other harness; `cross-or-self` additionally
 * lets the author's harness review in a fresh session while every other harness is
 * unavailable (usage limit), so one exhausted harness cannot block the other. */
export type ReviewPolicy = "cross" | "cross-or-self";

export interface AdapterConfig {
  cmd: string;
  models?: Record<EffortTier, ModelSpec>;
  /**
   * What this adapter runs when it acts as the configured `lead`: the decision points
   * (interactive/draft planning, the routing judge, escalation triage). These calls are
   * rare and judgment-heavy, so they may use a stronger model than the task tiers.
   * When omitted, the lead falls back to its `lead` tier.
   */
  leadModel?: ModelSpec;
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
function normalizeModelSpec(agent: string, value: unknown, field = "models entries"): ModelSpec | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return agent === "codex" ? { effort: value } : { model: value };
  if (typeof value === "object") {
    const { model, effort } = value as ModelSpec;
    return {
      ...(typeof model === "string" ? { model } : {}),
      ...(typeof effort === "string" ? { effort } : {}),
    };
  }
  throw new Error(`adapters.${agent}.${field} must be a string or { model, effort }`);
}

/**
 * The model the configured lead runs at a decision point (planning, routing, triage):
 * its `leadModel`, else its `lead` tier. Undefined defers to the harness default.
 */
export function resolveLeadModel(cfg: Pick<OrchConfig, "lead" | "adapters">): ModelSpec | undefined {
  const adapter = cfg.adapters[cfg.lead];
  return adapter?.leadModel ?? adapter?.models?.lead;
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
  /** Fix/conflict rounds the autonomous loop may spend on one task before handing it to a human. */
  maxReviewRounds: number;
  /**
   * Lead triages per task before a stuck task goes to a human (ADR-0010). When the round budget
   * is spent, the lead may grant one more guided round (optionally on a higher tier) or escalate
   * with a diagnosis. `0` escalates straight to a human, as before.
   */
  maxLeadTriage: number;
  worktreeRoot: string;
  maxConcurrent: number;
  taskTimeoutMs: number;
  /**
   * How long one automated review may run. Much shorter than a task: reading a diff takes minutes, and a
   * review that has not answered in this long is stuck (for instance waiting on sub-agents it spawned itself),
   * which is better failed and retried than waited on for the full task budget.
   */
  reviewTimeoutMs: number;
  defaultEffort?: EffortTier;
  /** Override legacy easy/hard names; canonical tier names always resolve directly. */
  tierAliases?: TierAliases;
  adapters: Record<string, AdapterConfig>;
  /** Per-million-token USD rates keyed by resolved model string, for computing a
   * cost fallback when a harness log reports none. Subscription-billed agents
   * (e.g. Codex) simply have no entry, so their cost stays null. */
  pricing: Record<string, ModelPricing>;
  /** Top-level ignored paths (a trailing `/` matches a directory and its contents)
   * that are regenerable build/install output, so a worktree holding only these
   * may still be removed safely. Any other ignored, untracked, or dirty path
   * keeps the worktree. */
  disposableIgnored: string[];
}

export const CONFIG_FILE = "orch.config.json";

/** Regenerable output that never makes a task worktree worth preserving. */
export const DEFAULT_DISPOSABLE_IGNORED: readonly string[] = ["node_modules/", "dist/", "coverage/", "logs/"];

export const DEFAULT_CONFIG: OrchConfig = {
  agents: ["claude", "codex"],
  lead: "claude",
  requireCrossReview: true,
  reviewPolicy: "cross-or-self",
  requireHumanMerge: false,
  maxReviewRounds: 3,
  maxLeadTriage: 1,
  worktreeRoot: "../wt",
  maxConcurrent: 2,
  taskTimeoutMs: 1_800_000, // 30 minutes
  reviewTimeoutMs: 900_000, // 15 minutes
  defaultEffort: "lead",
  // All tiers default to the same capable model at medium effort; set `models.lead`
  // (and `effort:` labels) to opt individual tasks into something stronger. Codex pins
  // its model explicitly so a user's ~/.codex/config.toml default never changes cost.
  // Claude as lead uses Opus at the few decision points (plan, route, triage); Codex as
  // lead has no separate lead model and uses its `lead` tier.
  adapters: {
    claude: {
      cmd: "claude",
      models: {
        free: { model: "claude-sonnet-5-5", effort: "medium" },
        cheap: { model: "claude-sonnet-5-5", effort: "medium" },
        standard: { model: "claude-sonnet-5-5", effort: "medium" },
        lead: { model: "claude-sonnet-5-5", effort: "medium" },
      },
      leadModel: { model: "claude-opus-5-5", effort: "high" },
    },
    codex: {
      cmd: "codex",
      models: {
        free: { model: "gpt-6.1-sol", effort: "medium" },
        cheap: { model: "gpt-6.1-sol", effort: "medium" },
        standard: { model: "gpt-6.1-sol", effort: "medium" },
        lead: { model: "gpt-6.1-sol", effort: "medium" },
      },
    },
  },
  pricing: DEFAULT_PRICING,
  disposableIgnored: [...DEFAULT_DISPOSABLE_IGNORED],
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
  if (
    Object.prototype.hasOwnProperty.call(raw, "maxReviewRounds") &&
    (!Number.isInteger(raw.maxReviewRounds) || (raw.maxReviewRounds as number) < 1)
  ) {
    throw new Error("maxReviewRounds must be a positive integer");
  }
  if (
    Object.prototype.hasOwnProperty.call(raw, "maxLeadTriage") &&
    (!Number.isInteger(raw.maxLeadTriage) || (raw.maxLeadTriage as number) < 0)
  ) {
    throw new Error("maxLeadTriage must be a non-negative integer");
  }
  if (
    Object.prototype.hasOwnProperty.call(raw, "disposableIgnored") &&
    (!Array.isArray(raw.disposableIgnored) ||
      !raw.disposableIgnored.every((p) => typeof p === "string" && p.trim().length > 0))
  ) {
    throw new Error("disposableIgnored must be an array of non-empty path strings when configured");
  }
  if (
    Object.prototype.hasOwnProperty.call(raw, "reviewTimeoutMs") &&
    (!Number.isInteger(raw.reviewTimeoutMs) || (raw.reviewTimeoutMs as number) < 1)
  ) {
    throw new Error("reviewTimeoutMs must be a positive integer (milliseconds)");
  }
  const aliases = raw.tierAliases ?? {};
  if (typeof aliases !== "object" || Array.isArray(aliases) ||
      Object.entries(aliases).some(([key, value]) =>
        !["easy", "hard"].includes(key) || !EFFORT_TIERS.includes(value))) {
    throw new Error("tierAliases must map easy/hard to free, cheap, standard, or lead");
  }
  const defaultEffort = raw.defaultEffort === undefined
    ? DEFAULT_CONFIG.defaultEffort : normalizeEffort(raw.defaultEffort, aliases);
  if (!defaultEffort) throw new Error("defaultEffort must be free, cheap, standard, lead, easy, or hard");
  const adapters = { ...DEFAULT_CONFIG.adapters };
  for (const [agent, override] of Object.entries(raw.adapters ?? {})) {
    const defaults = DEFAULT_CONFIG.adapters[agent];
    const merged = { ...defaults, ...override };
    if (defaults?.models || override.models) {
      // Merge defaults, aliased legacy keys, then canonical keys per field.
      const models: Partial<Record<EffortTier, ModelSpec>> = {};
      for (const tier of EFFORT_TIERS) {
        const legacy = Object.keys(DEFAULT_TIER_ALIASES)
          .filter((key) => normalizeEffort(key, aliases) === tier)
          .reduce<ModelSpec>((acc, key) => ({
            ...acc, ...normalizeModelSpec(agent, (override.models as Record<string, unknown> | undefined)?.[key]),
          }), {});
        const spec = {
          ...defaults?.models?.[tier],
          ...legacy,
          ...normalizeModelSpec(agent, (override.models as Record<string, unknown> | undefined)?.[tier]),
        };
        if (Object.keys(spec).length > 0) models[tier] = spec;
      }
      merged.models = models as Record<EffortTier, ModelSpec>;
    }
    if (defaults?.leadModel || override.leadModel !== undefined) {
      // Same partial merge: `{ leadModel: { effort: "max" } }` keeps the default lead model.
      const lead = {
        ...defaults?.leadModel,
        ...normalizeModelSpec(agent, override.leadModel as unknown, "leadModel"),
      };
      if (Object.keys(lead).length > 0) merged.leadModel = lead;
      else delete merged.leadModel;
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
    defaultEffort,
    tierAliases: aliases,
    pricing,
  };
}
