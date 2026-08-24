import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, loadConfig } from "../src/config.js";

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
      models: { easy: "sonnet", hard: "opus" },
    });
    expect(config.adapters.codex).toEqual({
      cmd: "codex",
      models: { easy: "low", hard: "high" },
    });
  });

  it("merges a partial nested model map with adapter defaults", () => {
    const config = loadConfig(writeConfig({
      adapters: { claude: { models: { easy: "haiku" } } },
    }));

    expect(config.adapters.claude).toEqual({
      cmd: "claude",
      models: { easy: "haiku", hard: "opus" },
    });
  });
});
