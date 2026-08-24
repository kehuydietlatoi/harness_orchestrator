import { describe, expect, it } from "vitest";
import {
  extractPlan,
  formatJudgePrompt,
  resultTextFromStreamJson,
  runJudge,
  type JudgeRun,
  type JudgeRunner,
} from "../src/judge.js";
import { DEFAULT_CONFIG, type OrchConfig } from "../src/config.js";

const cfg: OrchConfig = DEFAULT_CONFIG;

function runnerReturning(run: Partial<JudgeRun>): JudgeRunner {
  return async () => ({ code: 0, timedOut: false, text: "", raw: "", ...run });
}

describe("formatJudgePrompt", () => {
  it("embeds the brief, the effort policy, and the exact output contract", () => {
    const prompt = formatJudgePrompt("BRIEF-BODY");
    expect(prompt).toContain("BRIEF-BODY");
    expect(prompt).toContain("```json");
    expect(prompt).toContain('"rationale"');
    expect(prompt).toContain("easy =");
    expect(prompt).toContain("hard =");
    expect(prompt).toContain("break ties toward load balancing");
  });
});

describe("extractPlan", () => {
  it("parses the last fenced json block, tolerating leading prose", () => {
    const text =
      "Here is my routing decision based on telemetry:\n\n" +
      '```json\n[{"issue": 12, "agent": "codex", "effort": "easy", "rationale": "mechanical"}]\n```\n';
    expect(extractPlan(text)).toEqual([
      { issue: 12, agent: "codex", effort: "easy", rationale: "mechanical" },
    ]);
  });

  it("prefers the last json block when several are present", () => {
    const text =
      '```json\n[{"issue": 1, "agent": "claude", "effort": "hard"}]\n```\n' +
      "on reflection:\n" +
      '```json\n[{"issue": 2, "agent": "codex", "effort": "easy"}]\n```';
    expect(extractPlan(text).map((e) => e.issue)).toEqual([2]);
  });

  it("defaults a missing rationale to an empty string", () => {
    const plan = extractPlan('```json\n[{"issue": 3, "agent": "claude", "effort": "hard"}]\n```');
    expect(plan[0].rationale).toBe("");
  });

  it("throws when there is no fenced block", () => {
    expect(() => extractPlan("no code block here")).toThrow(/no fenced/i);
  });

  it("throws when the block is not valid JSON", () => {
    expect(() => extractPlan("```json\n{not json}\n```")).toThrow(/not valid JSON/i);
  });

  it("throws when the payload is not an array", () => {
    expect(() => extractPlan('```json\n{"issue": 1}\n```')).toThrow(/must be an array/i);
  });

  it("throws when an entry lacks an integer issue", () => {
    expect(() => extractPlan('```json\n[{"agent": "codex", "effort": "easy"}]\n```')).toThrow(
      /integer issue/i,
    );
  });
});

describe("resultTextFromStreamJson", () => {
  it("returns the final result line's text and ignores non-result lines", () => {
    const log =
      '{"type":"system","subtype":"init"}\n' +
      '{"type":"assistant","message":"thinking"}\n' +
      '{"type":"result","result":"FINAL TEXT"}\n';
    expect(resultTextFromStreamJson(log)).toBe("FINAL TEXT");
  });

  it("returns empty string when there is no result line", () => {
    expect(resultTextFromStreamJson('{"type":"assistant"}\n')).toBe("");
  });
});

describe("runJudge (fail-closed)", () => {
  const brief = "some brief";

  it("returns the parsed plan on a clean run", async () => {
    const runner = runnerReturning({
      text: '```json\n[{"issue": 5, "agent": "codex", "effort": "hard", "rationale": "design"}]\n```',
    });
    await expect(runJudge(brief, cfg, ".", runner)).resolves.toEqual([
      { issue: 5, agent: "codex", effort: "hard", rationale: "design" },
    ]);
  });

  it("throws on a non-zero exit and writes nothing", async () => {
    const runner = runnerReturning({ code: 1, raw: "boom" });
    await expect(runJudge(brief, cfg, ".", runner)).rejects.toThrow(/judge exited 1/);
  });

  it("throws on a timeout", async () => {
    const runner = runnerReturning({ timedOut: true });
    await expect(runJudge(brief, cfg, ".", runner)).rejects.toThrow(/timed out/i);
  });

  it("throws when the output cannot be parsed", async () => {
    const runner = runnerReturning({ text: "I could not decide." });
    await expect(runJudge(brief, cfg, ".", runner)).rejects.toThrow(/not parseable/i);
  });

  it("throws on an empty plan", async () => {
    const runner = runnerReturning({ text: "```json\n[]\n```" });
    await expect(runJudge(brief, cfg, ".", runner)).rejects.toThrow(/empty plan/i);
  });

  it("resolves the judge model to the lead's hard tier", async () => {
    let seenModel: string | undefined = "unset";
    const runner: JudgeRunner = async (_prompt, model) => {
      seenModel = model;
      return { code: 0, timedOut: false, text: '```json\n[{"issue":1,"agent":"claude","effort":"hard"}]\n```', raw: "" };
    };
    await runJudge(brief, cfg, ".", runner);
    expect(seenModel).toBe(cfg.adapters[cfg.lead].models?.hard);
  });
});
