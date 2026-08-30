import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_PRICING, type ModelPricing } from "./board/pricing.js";

export interface AdapterConfig {
  cmd: string;
  models?: {
    easy: string;
    hard: string;
  };
}

export interface OrchConfig {
  agents: string[];
  lead: string;
  /** GitHub branch name used as the base for task branches and pull requests.
   * When omitted, orch asks GitHub for the repository default branch. */
  baseBranch?: string;
  requireCrossReview: boolean;
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
  requireHumanMerge: false,
  worktreeRoot: "../wt",
  maxConcurrent: 2,
  taskTimeoutMs: 1_800_000, // 30 minutes
  defaultEffort: "hard",
  adapters: {
    claude: { cmd: "claude", models: { easy: "sonnet", hard: "opus" } },
    codex: { cmd: "codex", models: { easy: "low", hard: "high" } },
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
  const adapters = { ...DEFAULT_CONFIG.adapters };
  for (const [agent, override] of Object.entries(raw.adapters ?? {})) {
    const defaults = DEFAULT_CONFIG.adapters[agent];
    const merged = { ...defaults, ...override };
    if (defaults?.models || override.models) {
      merged.models = { ...defaults?.models, ...override.models } as NonNullable<AdapterConfig["models"]>;
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
