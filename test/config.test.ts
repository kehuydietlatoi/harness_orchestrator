import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, formatModelSpec, loadConfig } from "../src/config.js";

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
    });
  });

  it("defaults to cross-or-self review and validates the configured policy", () => {
    expect(loadConfig(writeConfig({})).reviewPolicy).toBe("cross-or-self");
    expect(loadConfig(writeConfig({ reviewPolicy: "cross" })).reviewPolicy).toBe("cross");
    for (const reviewPolicy of ["self", "", null, 1]) {
      expect(() => loadConfig(writeConfig({ reviewPolicy }))).toThrow(/reviewPolicy/);
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
