import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface AdapterConfig {
  cmd: string;
}

export interface OrchConfig {
  agents: string[];
  lead: string;
  requireCrossReview: boolean;
  requireHumanMerge: boolean;
  worktreeRoot: string;
  maxConcurrent: number;
  taskTimeoutMs: number;
  adapters: Record<string, AdapterConfig>;
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
  adapters: {
    claude: { cmd: "claude" },
    codex: { cmd: "codex" },
  },
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
  const text = readFileSync(p, "utf8").replace(/^﻿/, ""); // tolerate a UTF-8 BOM
  const raw = JSON.parse(text) as Partial<OrchConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    adapters: { ...DEFAULT_CONFIG.adapters, ...(raw.adapters ?? {}) },
  };
}
