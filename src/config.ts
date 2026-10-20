import { validateBudget, type Budget } from "./tasks/budget.js";
export type { Budget } from "./tasks/budget.js";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname, basename } from "node:path";
import { projectStateDir } from "./board/telemetry.js";
import { DEFAULT_PRICING, type ModelPricing } from "./board/pricing.js";
import { loadPack, type DomainPack } from "./pack/load.js";

/** What an adapter is told to run for one effort tier. Either field may be omitted
 * to defer to the harness's own configured default (e.g. `~/.codex/config.toml`). */
export interface ModelSpec {
  /** Explicit replacement for the harness's default capabilities. */
  capabilities?: string[];
  /** Harness-specific model id or alias (`claude-sonnet-5-5`, a Codex model id). */
  model?: string;
  /** Provider identity, overriding the adapter default. Required for OpenCode. */
  family?: string;
  /** Reasoning/thinking effort handed to the harness (`low|medium|high|xhigh|max`). */
  effort?: string;
}

export const EFFORT_TIERS = ["free", "cheap", "standard", "lead"] as const;
export type EffortTier = typeof EFFORT_TIERS[number];
export interface TierMember extends ModelSpec { agent: string }
export interface CascadeRoute extends TierMember { tier: EffortTier }
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

/** Reviews require premium different-family models. `cross-or-self` additionally
 * permits a marked premium author review when no eligible cross reviewer is available. */
export type ReviewPolicy = "cross" | "cross-or-self";

export interface AdapterConfig {
  cmd: string;
  /** Inherited variable names to restore after credential stripping (GitHub tokens are always denied). */
  env?: string[];
  family?: string;
  pricingMode?: "api" | "subscription" | "quota";
  models?: Record<EffortTier, ModelSpec>;
  /**
   * What this adapter runs when it acts as the configured `lead`: the decision points
   * (interactive/draft planning, the routing judge, escalation triage). These calls are
   * rare and judgment-heavy, so they may use a stronger model than the task tiers.
   * When omitted, the lead falls back to its `lead` tier.
   */
  leadModel?: ModelSpec;
}

export function resolvePricingMode(agent: string, cfg: Pick<OrchConfig, "adapters">): NonNullable<AdapterConfig["pricingMode"]> {
  return cfg.adapters[agent]?.pricingMode ?? (agent === "opencode" ? "quota" : agent === "codex" ? "subscription" : "api");
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
    const { model, effort, family, capabilities } = value as ModelSpec;
    validateCapabilities(capabilities, `adapters.${agent}.${field}.capabilities`);
    if (family !== undefined && (typeof family !== "string" || !family.trim())) {
      throw new Error(`adapters.${agent}.${field}.family must be a non-empty string`);
    }
    return {
      ...(capabilities !== undefined ? { capabilities } : {}),
      ...(family !== undefined ? { family } : {}),
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

/** Resolve provider identity independently of model names and harness commands. */
export function resolveFamily(
  agent: string,
  spec: ModelSpec | undefined,
  cfg: Partial<Pick<OrchConfig, "adapters">>,
): string | undefined {
  if (agent === "opencode") return spec?.family;
  return spec?.family ?? cfg.adapters?.[agent]?.family ??
    ({ claude: "anthropic", codex: "openai" } as Record<string, string>)[agent];
}

function validateCapabilities(value: unknown, field: string): void {
  if (value !== undefined && (!Array.isArray(value) || !value.every(v => typeof v === "string" && v.trim().length > 0))) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
}

/** Defaults describe proven headless worker tools, never inferred from model names. */
export function resolveCapabilities(agent: string, spec?: ModelSpec): readonly string[] {
  return spec?.capabilities ?? ({ claude: ["shell", "vision"], codex: ["shell", "vision"], opencode: ["shell"] } as Record<string, string[]>)[agent] ?? [];
}

export interface OrchConfig {
  sensitivity?: {
    default?: "public" | "internal" | "secret";
    secret?: { families?: string[] };
    internal?: { families?: string[]; allow?: string[] };
  };
  /** Domain pack path, relative to the project config directory. */
  pack?: string;
  /** Loaded by loadConfig; never read from serialized config. */
  loadedPack?: DomainPack;
  /** Ordered implementation fallback ladder. Omitted preserves single-member retries. */
  tierMembers?: Record<EffortTier, TierMember[]>;
  roles: Record<string, { tiers: EffortTier[]; families: string[] }>;
  agents: string[];
  lead: string;
  /** GitHub branch name used as the base for task branches and pull requests.
   * When omitted, orch asks GitHub for the repository default branch. */
  baseBranch?: string;
  requireCrossReview: boolean;
  reviewPolicy: ReviewPolicy;
  /** Ordered resolver harnesses; <author> expands to the task author. */
  conflictResolvers: string[];
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
  /** Trusted local checks, executed directly in the task worktree before auto-commit. */
  verify?: string[][];
  /** Trusted argv prefix for collecting scenario evidence. */
  evidence?: string[];
  evidenceSetup?: string[][];
  scenariosDir?: string;
  evidenceDir?: string;
  evidenceTimeoutMs?: number;
  /** Repository-relative globs whose changes require a current lead-tier approval. */
  protectedPaths?: string[];
  budgets?: { default?: Budget; byTier?: Partial<Record<EffortTier, Budget>> };
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
  /** Ignored paths (a trailing `/` matches a directory and its contents;
   * filename globs with `*` and `?` match only root-level files)
   * that are regenerable build/install output, so a worktree holding only these
   * may still be removed safely. Any other ignored, untracked, or dirty path
   * keeps the worktree. */
  disposableIgnored: string[];
}

export const CONFIG_FILE = "orch.config.json";
export const DEFAULT_PROTECTED_PATHS = [
  "**/package.json", "**/vitest.config.*", "**/jest.config.*", "**/.mocharc*",
  "**/playwright.config.*", "**/orch.config.json",
];

/** Regenerable output that never makes a task worktree worth preserving. */
export const DEFAULT_DISPOSABLE_IGNORED: readonly string[] = ["node_modules/", "dist/", "coverage/", "logs/", "*.log"];

export const DEFAULT_CONFIG: OrchConfig = {
  roles: {},
  protectedPaths: [...DEFAULT_PROTECTED_PATHS],
  agents: ["claude", "codex"],
  lead: "claude",
  requireCrossReview: true,
  reviewPolicy: "cross",
  conflictResolvers: ["claude", "<author>"],
  requireHumanMerge: false,
  maxReviewRounds: 3,
  maxLeadTriage: 1,
  worktreeRoot: "../wt",
  maxConcurrent: 2,
  taskTimeoutMs: 1_800_000, // 30 minutes
  scenariosDir: "qa/scenarios",
  evidenceTimeoutMs: 300_000,
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
      family: "anthropic",
      pricingMode: "api",
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
      family: "openai",
      pricingMode: "subscription",
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

/** Resolve aliases even for paths whose final directories have not been created. */
function canonicalPath(path: string): string {
  if (existsSync(path)) return realpathSync.native(path);
  const parent = dirname(path);
  return parent === path ? path : resolve(canonicalPath(parent), basename(path));
}

function pathWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

export function loadConfig(cwd: string = process.cwd()): OrchConfig {
  const p = configPath(cwd);
  if (!existsSync(p)) {
    throw new Error(`No ${CONFIG_FILE} found in ${cwd}. Run \`orch init\` first.`);
  }
  const text = readFileSync(p, "utf8").replace(/^\uFEFF/, ""); // tolerate a UTF-8 BOM
  const raw = JSON.parse(text) as Partial<OrchConfig>;
  const argvValid = (argv: unknown): argv is string[] => Array.isArray(argv) && argv.length > 0 &&
    argv.every(arg => typeof arg === "string" && arg.trim().length > 0 && !arg.includes("\0"));
  if (Object.hasOwn(raw, "evidence") && !argvValid(raw.evidence)) {
    throw new Error("evidence must be a non-empty argv array of non-empty strings");
  }
  if (Object.hasOwn(raw, "evidenceSetup") && (!Array.isArray(raw.evidenceSetup) || !raw.evidenceSetup.every(argvValid))) {
    throw new Error("evidenceSetup must be a list of non-empty argv arrays of non-empty strings");
  }
  const scenariosDir = raw.scenariosDir === undefined ? DEFAULT_CONFIG.scenariosDir! : raw.scenariosDir;
  if (typeof scenariosDir !== "string" || !scenariosDir.trim() || /[\x00-\x1f:]/.test(scenariosDir) ||
      /^[\\/]/.test(scenariosDir) || scenariosDir.split(/[\\/]/).includes("..") ||
      !pathWithin(canonicalPath(cwd), canonicalPath(resolve(cwd, scenariosDir)))) {
    throw new Error("scenariosDir must be a repository-relative path that does not escape the repo");
  }
  if (raw.evidenceDir !== undefined && (typeof raw.evidenceDir !== "string" || !raw.evidenceDir.trim() || /[\x00-\x1f]/.test(raw.evidenceDir))) {
    throw new Error("evidenceDir must be a non-empty path outside the repository");
  }
  const evidenceDir = resolve(cwd, raw.evidenceDir ?? resolve(projectStateDir(cwd), "evidence"));
  if (pathWithin(canonicalPath(cwd), canonicalPath(evidenceDir))) {
    throw new Error("evidenceDir must be outside the repository checkout");
  }
  if (Object.hasOwn(raw, "evidenceTimeoutMs") && (!Number.isInteger(raw.evidenceTimeoutMs) || raw.evidenceTimeoutMs! < 1)) {
    throw new Error("evidenceTimeoutMs must be a positive integer (milliseconds)");
  }
  if (raw.sensitivity !== undefined) {
    const s = raw.sensitivity;
    if (!s || typeof s !== "object" || Array.isArray(s) ||
        (s.default !== undefined && !["public", "internal", "secret"].includes(s.default))) {
      throw new Error("sensitivity must be an object with a public, internal, or secret default");
    }
    for (const key of ["secret", "internal"] as const) {
      const policy = s[key];
      if (policy !== undefined && (!policy || typeof policy !== "object" || Array.isArray(policy))) {
        throw new Error(`sensitivity.${key} must be an object`);
      }
      validateCapabilities(policy?.families, `sensitivity.${key}.families`);
    }
    validateCapabilities(s.internal?.allow, "sensitivity.internal.allow");
  }
  if (raw.protectedPaths !== undefined && (!Array.isArray(raw.protectedPaths) ||
      !raw.protectedPaths.every((path) => typeof path === "string" && path.trim().length > 0 &&
        ![...path].some((char) => char.charCodeAt(0) < 32) && !/^(?:[\\/]|[a-z]:)/i.test(path) && !path.split(/[\\/]/).includes("..")))) {
    throw new Error("protectedPaths must be a list of repository-relative path globs");
  }
  if (Object.prototype.hasOwnProperty.call(raw, "verify") &&
      (!Array.isArray(raw.verify) || !raw.verify.every(argvValid))) {
    throw new Error("verify must be a list of non-empty argv arrays of non-empty strings");
  }
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
  if (raw.conflictResolvers !== undefined &&
      (!Array.isArray(raw.conflictResolvers) ||
       !raw.conflictResolvers.every((agent) => typeof agent === "string" && agent.trim().length > 0))) {
    throw new Error("conflictResolvers must be an array of non-empty harness names or <author>");
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
  if (raw.pack !== undefined && (typeof raw.pack !== "string" || !raw.pack.trim())) {
    throw new Error("pack must be a non-empty directory path");
  }
  const loadedPack = raw.pack === undefined ? undefined : loadPack(raw.pack, cwd);
  const roles: OrchConfig["roles"] = Object.fromEntries(Object.entries(loadedPack?.roles ?? {})
    .map(([id, { manifest }]) => [id, { tiers: manifest.tiers, families: manifest.families }]));
  if (raw.roles !== undefined) {
    if (!raw.roles || typeof raw.roles !== "object" || Array.isArray(raw.roles)) {
      throw new Error("roles must be an object of { tiers, families } allowances");
    }
    for (const [role, allowance] of Object.entries(raw.roles)) {
      const tiers = Array.isArray(allowance?.tiers)
        ? (allowance.tiers as unknown[]).map((tier) => normalizeEffort(tier, aliases)) : undefined;
      if (!tiers || tiers.some((tier) => !tier)) {
        throw new Error(`roles.${role}.tiers must contain only known tiers: ${EFFORT_TIERS.join(", ")}, easy, hard`);
      }
      if (!Array.isArray(allowance.families) ||
          !allowance.families.every((family) => typeof family === "string" && family.trim().length > 0)) {
        throw new Error(`roles.${role}.families must be an array of non-empty strings`);
      }
      roles[role] = { tiers: tiers as EffortTier[], families: allowance.families };
    }
  }
  let budgets = raw.budgets;
  if (raw.budgets !== undefined) {
    if (!raw.budgets || typeof raw.budgets !== "object" || Array.isArray(raw.budgets)) throw new Error("budgets must be an object");
    if (raw.budgets.default !== undefined) validateBudget(raw.budgets.default);
    if (raw.budgets.byTier !== undefined) {
      if (!raw.budgets.byTier || typeof raw.budgets.byTier !== "object" || Array.isArray(raw.budgets.byTier)) throw new Error("budgets.byTier must be an object");
      const byTier: Partial<Record<EffortTier, Budget>> = {};
      for (const [key, budget] of Object.entries(raw.budgets.byTier)) {
        const tier = normalizeEffort(key, aliases);
        if (!tier) throw new Error("Invalid budget tier: " + key);
        validateBudget(budget);
        byTier[tier] = budget as Budget;
      }
      budgets = { ...raw.budgets, byTier };
    }
  }
  const adapters = { ...DEFAULT_CONFIG.adapters };
  for (const [agent, override] of Object.entries(raw.adapters ?? {})) {
    const defaults = DEFAULT_CONFIG.adapters[agent];
    const merged = { ...defaults, ...override };
    if (merged.env !== undefined && (!Array.isArray(merged.env) || !merged.env.every(name => typeof name === "string" && /^[a-z_][a-z0-9_]*$/i.test(name)))) {
      throw new Error(`adapters.${agent}.env must be a list of environment variable names`);
    }
    merged.pricingMode ??= agent === "opencode" ? "quota" : agent === "codex" ? "subscription" : "api";
    if (!["api", "subscription", "quota"].includes(merged.pricingMode)) {
      throw new Error(`adapters.${agent}.pricingMode must be api, subscription, or quota`);
    }
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
    if (merged.family !== undefined && (typeof merged.family !== "string" || !merged.family.trim())) {
      throw new Error(`adapters.${agent}.family must be a non-empty string`);
    }
    if (agent === "opencode") {
      for (const [field, spec] of Object.entries({ ...merged.models, leadModel: merged.leadModel })) {
        if (spec && !spec.family) throw new Error(`adapters.opencode.${field}.family is required per model`);
      }
    }
    adapters[agent] = merged;
  }
  // Merge pricing so a config that sets only some models keeps the built-in
  // defaults for the rest (self-heals like the label set does).
  const pricing = { ...DEFAULT_CONFIG.pricing, ...raw.pricing };
  if (raw.tierMembers !== undefined) {
    if (!raw.tierMembers || typeof raw.tierMembers !== "object" || Array.isArray(raw.tierMembers) ||
        Object.keys(raw.tierMembers).some((tier) => !EFFORT_TIERS.includes(tier as EffortTier))) {
      throw new Error("tierMembers must map canonical tiers to ordered member arrays");
    }
    for (const tier of EFFORT_TIERS) {
      const members = raw.tierMembers[tier];
      if (!Array.isArray(members)) throw new Error(`tierMembers.${tier} must be an array`);
      const seen = new Set<string>();
      for (const member of members) {
        validateCapabilities(member?.capabilities, `tierMembers.${tier}.capabilities`);
        if (!member || !(raw.agents ?? DEFAULT_CONFIG.agents).includes(member.agent) || !adapters[member.agent]) {
          throw new Error(`tierMembers.${tier} requires a configured agent`);
        }
        for (const field of ["model", "effort", "family"] as const) {
          if (member[field] !== undefined && (typeof member[field] !== "string" || !member[field]!.trim())) {
            throw new Error(`tierMembers.${tier}.${field} must be a non-empty string`);
          }
        }
        const spec = { ...adapters[member.agent]?.models?.[tier], ...member };
        if (member.agent === "opencode" && (!spec.model || !spec.family)) {
          throw new Error(`tierMembers.${tier}: OpenCode requires model and family`);
        }
        const key = `${member.agent}:${spec.model ?? ""}`;
        if (seen.has(key)) throw new Error(`tierMembers.${tier} has duplicate agent/model members`);
        seen.add(key);
        if (spec.model && `model:${spec.model}`.length > 50) throw new Error("tierMembers model label exceeds 50 characters");
      }
    }
  }
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    scenariosDir,
    evidenceDir,
    adapters,
    roles,
    loadedPack,
    ...(budgets ? { budgets } : {}),
    defaultEffort,
    tierAliases: aliases,
    pricing,
  };
}

export class UnknownModelProjection extends Error {
  constructor(readonly label: string, agent: string, tier: EffortTier) {
    super(`Unknown model projection '${label.slice(6)}' for '${agent}' at '${tier}' (${label}); run orch repair to remove the stale label`);
    this.name = "UnknownModelProjection";
  }
}

/** Resolve a projected member on the next claim, including its reasoning effort and family. */
export function resolveTierModel(agent: string, tier: EffortTier, cfg: OrchConfig, labels: readonly string[] = []): ModelSpec | undefined {
  const base = cfg.adapters[agent]?.models?.[tier];
  const projection = labels.find((label) => label.startsWith("model:"))?.slice(6);
  const members = cfg.tierMembers?.[tier].filter((member) => member.agent === agent);
  const member = projection === undefined ? members?.[0] : members?.find((m) => (m.model ?? base?.model) === projection);
  if (projection !== undefined && !member) throw new UnknownModelProjection(`model:${projection}`, agent, tier);
  if (!member) return base;
  return {
    ...base,
    ...(member.capabilities !== undefined ? { capabilities: member.capabilities } : {}),
    ...(member.model !== undefined ? { model: member.model } : {}),
    ...(member.effort !== undefined ? { effort: member.effort } : {}),
    ...(member.family !== undefined ? { family: member.family } : {}),
  };
}
