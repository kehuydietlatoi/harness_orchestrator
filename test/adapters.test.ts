import { describe, expect, it } from "vitest";
import {
  buildClaudeInteractivePlanArgs,
  buildClaudeTaskArgs,
  resultTextFromClaudeStreamJson,
} from "../src/adapters/claude.js";
import { buildCodexTaskArgs, resultTextFromCodexJson } from "../src/adapters/codex.js";
import { makeAdapter } from "../src/adapters/index.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { configuredAdapterCommands } from "../src/commands/doctor.js";

describe("task adapter arguments", () => {
  it("leaves Claude task arguments unchanged without a model", () => {
    expect(buildClaudeTaskArgs()).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Read,Edit,Write,Bash",
    ]);
  });

  it("appends Claude's model flag when a model is set", () => {
    expect(buildClaudeTaskArgs("opus")).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Read,Edit,Write,Bash",
      "--model",
      "opus",
    ]);
  });

  it("leaves Codex task arguments unchanged without a model", () => {
    expect(buildCodexTaskArgs()).toEqual(["exec", "--approve-for-me", "--json"]);
  });

  it("appends Codex's reasoning effort flag when a model is set", () => {
    const args = buildCodexTaskArgs("high");
    expect(args).toEqual([
      "exec",
      "--approve-for-me",
      "--json",
      "-c",
      "model_reasoning_effort=high",
    ]);
    expect(args).not.toContain("-p");
    expect(args).not.toContain("--output-format");
    expect(args).not.toContain("--model");
  });
});

describe("lead adapter capabilities", () => {
  it("supports structured planner/judge runs with both built-in adapters", () => {
    expect(makeAdapter("claude", DEFAULT_CONFIG).runHeadless).toBeTypeOf("function");
    expect(makeAdapter("codex", DEFAULT_CONFIG).runHeadless).toBeTypeOf("function");
  });

  it("supports interactive planning only where the adapter defines it", () => {
    expect(makeAdapter("claude", DEFAULT_CONFIG).runInteractivePlan).toBeTypeOf("function");
    expect(makeAdapter("codex", DEFAULT_CONFIG).runInteractivePlan).toBeUndefined();
  });
});

describe("doctor adapter commands", () => {
  it("validates configured commands and includes a lead omitted from agents", () => {
    expect(
      configuredAdapterCommands({
        ...DEFAULT_CONFIG,
        agents: ["codex"],
        lead: "claude",
        adapters: {
          ...DEFAULT_CONFIG.adapters,
          claude: { ...DEFAULT_CONFIG.adapters.claude, cmd: "custom-claude" },
          codex: { ...DEFAULT_CONFIG.adapters.codex, cmd: "custom-codex" },
        },
      }),
    ).toEqual([
      { id: "codex", cmd: "custom-codex" },
      { id: "claude", cmd: "custom-claude" },
    ]);
  });
});

describe("structured lead output", () => {
  it("reduces Claude stream-json to the final result", () => {
    const log =
      '{"type":"system","subtype":"init"}\n' +
      '{"type":"result","result":"FIRST"}\n' +
      '{"type":"result","result":"FINAL TEXT"}\n';
    expect(resultTextFromClaudeStreamJson(log)).toBe("FINAL TEXT");
  });

  it("reduces Codex JSONL to the final completed agent message", () => {
    const log =
      '{"type":"thread.started","thread_id":"abc"}\n' +
      '{"type":"item.completed","item":{"type":"agent_message","text":"FIRST"}}\n' +
      '{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"ignored"}}\n' +
      '{"type":"item.completed","item":{"type":"agent_message","text":"FINAL TEXT"}}\n';
    expect(resultTextFromCodexJson(log)).toBe("FINAL TEXT");
  });

  it("ignores malformed and unrelated structured lines", () => {
    expect(resultTextFromClaudeStreamJson('not-json\n{"type":"assistant"}\n')).toBe("");
    expect(resultTextFromCodexJson('not-json\n{"type":"turn.completed"}\n')).toBe("");
  });
});

describe("Claude interactive planning arguments", () => {
  it("carries the seed, allows Write, and sets the model", () => {
    const args = buildClaudeInteractivePlanArgs("opus", "SEED");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("SEED");
    expect(args).toContain("Write");
    expect(args.slice(-2)).toEqual(["--model", "opus"]);
  });

  it("omits --model when none is configured", () => {
    expect(buildClaudeInteractivePlanArgs(undefined, "SEED")).not.toContain("--model");
  });
});
