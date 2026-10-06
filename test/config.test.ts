import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, DEFAULT_CONFIG, formatModelSpec, loadConfig, resolveLeadModel } from "../src/config.js";

describe("loadConfig", () => {
  let dir = "";

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(config: unknown): string {
    dir = mkdtempSync(join(tmpdir(), "orch-config-"));
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(config), "utf8");
    return dir;
  }

  it("fills effort and model defaults for an older config", () => {
    const config = loadConfig(writeConfig({
      agents: ["claude", "codex"],
      adapters: { claude: { cmd: "custom-claude" } },
    }));

    expect(config.defaultEffort).toBe("hard");
    expect(config.adapters.claude).toEqual({
      cmd: "custom-claude",
      models: {
        easy: { model: "claude-sonnet-5-5", effort: "medium" },
        hard: { model: "claude-sonnet-5-5", effort: "medium" },
      },
      leadModel: { model: "claude-opus-5-5", effort: "high" },
    });
    expect(config.adapters.codex).toEqual({
      cmd: "codex",
      models: {
        easy: { model: "gpt-6.1-sol", effort: "medium" },
        hard: { model: "gpt-6.1-sol", effort: "medium" },
      },
    });
  });

  it("reads legacy string tiers: Codex's is an effort, others' are models", () => {
    const config = loadConfig(writeConfig({
      adapters: {
        claude: { models: { easy: "sonnet", hard: "opus" } },
        codex: { models: { easy: "low", hard: "high" } },
      },
    }));

    expect(config.adapters.claude.models).toEqual({
      easy: { model: "sonnet", effort: "medium" },
      hard: { model: "opus", effort: "medium" },
    });
    expect(config.adapters.codex.models).toEqual({
      easy: { model: "gpt-6.1-sol", effort: "low" },
      hard: { model: "gpt-6.1-sol", effort: "high" },
    });
  });

  it("merges a partial spec per tier, keeping the default model", () => {
    const config = loadConfig(writeConfig({
      adapters: { claude: { models: { hard: { effort: "high" } } } },
    }));

    expect(config.adapters.claude.models?.hard).toEqual({ model: "claude-sonnet-5-5", effort: "high" });
    expect(config.adapters.claude.models?.easy).toEqual({ model: "claude-sonnet-5-5", effort: "medium" });
  });

  it("lets a config override the pinned Codex model without losing its effort default", () => {
    const config = loadConfig(writeConfig({
      adapters: { codex: { models: { easy: { model: "my-model" }, hard: { model: "my-model" } } } },
    }));

    expect(config.adapters.codex.models?.hard).toEqual({ model: "my-model", effort: "medium" });
  });

  it("formats a spec as model@effort for telemetry", () => {
    expect(formatModelSpec({ model: "m", effort: "medium" })).toBe("m@medium");
    expect(formatModelSpec({ effort: "medium" })).toBe("default@medium");
    expect(formatModelSpec({})).toBeUndefined();
    expect(formatModelSpec(undefined)).toBeUndefined();
  });

  it("merges a partial nested model map with adapter defaults", () => {
    const config = loadConfig(writeConfig({
      adapters: { claude: { models: { easy: "haiku" } } },
    }));

    expect(config.adapters.claude).toEqual({
      cmd: "claude",
      models: {
        easy: { model: "haiku", effort: "medium" },
        hard: { model: "claude-sonnet-5-5", effort: "medium" },
      },
      leadModel: { model: "claude-opus-5-5", effort: "high" },
    });
  });

  it("runs a Claude lead on Opus and merges a partial leadModel with the default", () => {
    expect(resolveLeadModel(loadConfig(writeConfig({})))).toEqual({ model: "claude-opus-5-5", effort: "high" });
    rmSync(dir, { recursive: true, force: true });
    const partial = loadConfig(writeConfig({ adapters: { claude: { leadModel: { effort: "max" } } } }));
    expect(partial.adapters.claude.leadModel).toEqual({ model: "claude-opus-5-5", effort: "max" });
    rmSync(dir, { recursive: true, force: true });
    // Legacy string form follows the tier rule: a model for Claude, an effort for Codex.
    const legacy = loadConfig(writeConfig({ adapters: { claude: { leadModel: "opus" }, codex: { leadModel: "xhigh" } } }));
    expect(legacy.adapters.claude.leadModel).toEqual({ model: "opus", effort: "high" });
    expect(legacy.adapters.codex.leadModel).toEqual({ effort: "xhigh" });
    rmSync(dir, { recursive: true, force: true });
    expect(() => loadConfig(writeConfig({ adapters: { claude: { leadModel: 7 } } }))).toThrow(/adapters\.claude\.leadModel/);
  });

  it("falls back to the lead's hard tier when it has no leadModel", () => {
    const codexLead = loadConfig(writeConfig({ lead: "codex" }));
    expect(codexLead.adapters.codex.leadModel).toBeUndefined();
    expect(resolveLeadModel(codexLead)).toEqual({ model: "gpt-6.1-sol", effort: "medium" });
    expect(resolveLeadModel({ lead: "claude", adapters: { claude: { cmd: "claude", models: DEFAULT_CONFIG.adapters.claude.models } } }))
      .toEqual({ model: "claude-sonnet-5-5", effort: "medium" });
    expect(resolveLeadModel({ lead: "missing", adapters: {} })).toBeUndefined();
  });

  it("defaults to cross-or-self review and validates the configured policy", () => {
    expect(loadConfig(writeConfig({})).reviewPolicy).toBe("cross-or-self");
    expect(loadConfig(writeConfig({ reviewPolicy: "cross" })).reviewPolicy).toBe("cross");
    for (const reviewPolicy of ["self", "", null, 1]) {
      expect(() => loadConfig(writeConfig({ reviewPolicy }))).toThrow(/reviewPolicy/);
    }
  });

  it("gives automated reviews their own, shorter timeout and rejects an invalid one", () => {
    const config = loadConfig(writeConfig({}));
    expect(config.reviewTimeoutMs).toBe(900_000);
    expect(config.reviewTimeoutMs).toBeLessThan(config.taskTimeoutMs);
    expect(loadConfig(writeConfig({ reviewTimeoutMs: 120_000 })).reviewTimeoutMs).toBe(120_000);
    for (const reviewTimeoutMs of [0, -5, 1.5, "900000", null]) {
      expect(() => loadConfig(writeConfig({ reviewTimeoutMs }))).toThrow(/reviewTimeoutMs/);
    }
  });

  it("defaults the review round budget and rejects an invalid one", () => {
    expect(loadConfig(writeConfig({})).maxReviewRounds).toBe(3);
    expect(loadConfig(writeConfig({ maxReviewRounds: 5 })).maxReviewRounds).toBe(5);
    for (const maxReviewRounds of [0, -1, 1.5, "3", null]) {
      expect(() => loadConfig(writeConfig({ maxReviewRounds }))).toThrow(/maxReviewRounds/);
    }
  });

  it("defaults and overrides the disposable ignored allowlist, rejecting malformed values", () => {
    expect(loadConfig(writeConfig({})).disposableIgnored).toEqual(["node_modules/", "dist/", "coverage/", "logs/"]);
    rmSync(dir, { recursive: true, force: true });
    expect(loadConfig(writeConfig({ disposableIgnored: [".venv/"] })).disposableIgnored).toEqual([".venv/"]);
    for (const bad of ["node_modules/", [""], [1]]) {
      rmSync(dir, { recursive: true, force: true });
      expect(() => loadConfig(writeConfig({ disposableIgnored: bad }))).toThrow(/disposableIgnored/);
    }
  });

  it("leaves baseBranch unset so repositories use their GitHub default", () => {
    const config = loadConfig(writeConfig({}));

    expect(config.baseBranch).toBeUndefined();
  });

  it("preserves a configured custom base branch", () => {
    const config = loadConfig(writeConfig({ baseBranch: "release/v2" }));

    expect(config.baseBranch).toBe("release/v2");
  });

  it.each(["", "   ", null, 42])("rejects an invalid configured base branch: %j", (baseBranch) => {
    expect(() => loadConfig(writeConfig({ baseBranch }))).toThrow(/baseBranch.*non-empty string/);
  });
});
