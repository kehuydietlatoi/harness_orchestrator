import { describe, expect, it } from "vitest";
import { buildClaudeTaskArgs } from "../src/adapters/claude.js";
import { buildCodexTaskArgs } from "../src/adapters/codex.js";

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
    expect(buildCodexTaskArgs("high")).toEqual([
      "exec",
      "--approve-for-me",
      "--json",
      "-c",
      "model_reasoning_effort=high",
    ]);
  });
});
