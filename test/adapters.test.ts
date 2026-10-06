import { describe, expect, it } from "vitest";
import {
  buildClaudeInteractivePlanArgs,
  buildClaudeReviewArgs,
  buildClaudeTaskArgs,
  resultTextFromClaudeStreamJson,
} from "../src/adapters/claude.js";
import {
  buildCodexReviewArgs,
  buildCodexTaskArgs,
  resultTextFromCodexJson,
  sessionIdFromCodexJson,
} from "../src/adapters/codex.js";
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

  it("appends Claude's model and effort flags when a spec is set", () => {
    expect(buildClaudeTaskArgs({ model: "claude-sonnet-5-5", effort: "medium" })).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Read,Edit,Write,Bash",
      "--model",
      "claude-sonnet-5-5",
      "--effort",
      "medium",
    ]);
  });

  it("emits only the Claude flag that the spec defines", () => {
    expect(buildClaudeTaskArgs({ effort: "high" }).slice(-2)).toEqual(["--effort", "high"]);
    expect(buildClaudeTaskArgs({ model: "opus" }).slice(-2)).toEqual(["--model", "opus"]);
    expect(buildClaudeTaskArgs({ model: "opus" })).not.toContain("--effort");
  });

  it("leaves Codex task arguments unchanged without a model", () => {
    expect(buildCodexTaskArgs()).toEqual(["exec", "--approve-for-me", "--json"]);
  });

  it("appends Codex's reasoning effort flag when only an effort is set", () => {
    const args = buildCodexTaskArgs({ effort: "high" });
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
    expect(args).not.toContain("-m");
  });

  it("passes Codex's -m model before the effort override", () => {
    expect(buildCodexTaskArgs({ model: "gpt-6-astra", effort: "medium" })).toEqual([
      "exec",
      "--approve-for-me",
      "--json",
      "-m",
      "gpt-6-astra",
      "-c",
      "model_reasoning_effort=medium",
    ]);
  });
});

describe("session continuity arguments", () => {
  const id = "e72ad3d7-549f-484d-8cf0-9d11145508fb";

  it("starts a Claude conversation under a chosen id so it can be resumed later", () => {
    const args = buildClaudeTaskArgs({ model: "m" }, { id, resume: false });
    expect(args[args.indexOf("--session-id") + 1]).toBe(id);
    expect(args).not.toContain("--resume");
  });

  it("resumes a Claude conversation by id", () => {
    const args = buildClaudeTaskArgs({ model: "m", effort: "medium" }, { id, resume: true });
    expect(args[args.indexOf("--resume") + 1]).toBe(id);
    expect(args).not.toContain("--session-id");
    expect(args.slice(-4)).toEqual(["--model", "m", "--effort", "medium"]);
  });

  it("leaves Claude arguments untouched without a session", () => {
    expect(buildClaudeTaskArgs()).not.toContain("--session-id");
    expect(buildClaudeTaskArgs()).not.toContain("--resume");
  });

  it("resumes Codex with exec options before the subcommand and the prompt on stdin", () => {
    expect(buildCodexTaskArgs({ model: "gpt-6.1-sol", effort: "medium" }, id)).toEqual([
      "exec", "--approve-for-me", "--json", "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=medium",
      "resume", id, "-",
    ]);
    expect(buildCodexTaskArgs({ effort: "high" })).not.toContain("resume");
  });

  it("reads the newest Codex thread id from a log", () => {
    const log =
      '{"type":"thread.started","thread_id":"old-1"}\n' +
      '{"type":"turn.started"}\n' +
      "not json thread.started\n" +
      '{"type":"thread.started","thread_id":"new-2"}\n';
    expect(sessionIdFromCodexJson(log)).toBe("new-2");
    expect(sessionIdFromCodexJson('{"type":"turn.started"}')).toBeUndefined();
    expect(sessionIdFromCodexJson("")).toBeUndefined();
  });
});

describe("read-only reviewer arguments", () => {
  it("gives Claude read tools only and explicitly denies edits and shell", () => {
    const args = buildClaudeReviewArgs({ model: "claude-sonnet-5-5", effort: "medium" });
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read,Grep,Glob");
    const denied = args[args.indexOf("--disallowedTools") + 1].split(",");
    expect(denied).toEqual(expect.arrayContaining(["Edit", "Write", "Bash"]));
    expect(args).not.toContain("acceptEdits");
    expect(args.slice(-4)).toEqual(["--model", "claude-sonnet-5-5", "--effort", "medium"]);
  });

  it("runs Codex in its read-only sandbox without auto-approval", () => {
    const args = buildCodexReviewArgs({ model: "gpt-6.1-sol", effort: "medium" });
    expect(args).toEqual(["exec", "--json", "-s", "read-only", "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=medium"]);
    expect(args).not.toContain("--approve-for-me");
    expect(buildCodexReviewArgs()).toEqual(["exec", "--json", "-s", "read-only"]);
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
    const args = buildClaudeInteractivePlanArgs({ model: "opus", effort: "high" }, "SEED");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("SEED");
    expect(args).toContain("Write");
    expect(args.slice(-4)).toEqual(["--model", "opus", "--effort", "high"]);
  });

  it("omits --model when none is configured", () => {
    expect(buildClaudeInteractivePlanArgs(undefined, "SEED")).not.toContain("--model");
  });
});
