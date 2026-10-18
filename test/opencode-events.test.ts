import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOpencodeArgv, reduceOpencode } from "../src/adapters/opencode-events.js";

const fixtures = new URL("./fixtures/opencode-1.19.3/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, fixtures), "utf8");
const event = (type: string, part: object = {}, sessionID = "first") => ({ type, sessionID, part });
const finish = (reason = "stop") => event("step_finish", { reason });
const apiError = (statusCode?: number, isRetryable = false, responseHeaders = {}) => ({
  type: "error", sessionID: "first", error: { name: "APIError", data: { statusCode, isRetryable, responseHeaders } },
});
function reduce(events: object[], overrides: Partial<Parameters<typeof reduceOpencode>[0]> = {}) {
  return reduceOpencode({ lines: events.map(e => JSON.stringify(e)).join("\n"), exitCode: 0, timedOut: false, stderr: "", ...overrides });
}

describe("OpenCode 1.19.3 fixtures", () => {
  const cases = [
    ["success-edit", "completed", 0],
    ["deny-then-stop", "completed", 0],
    ["resume-session", "completed", 0],
    ["error-503-retryable", "endpoint-unavailable", 1],
    ["ask-auto-rejected-early-stop", "incomplete", 0],
  ] as const;

  it("covers all six copied fixture files", () => {
    expect(readdirSync(fixtures).sort()).toEqual([
      ...cases.map(([name]) => `${name}.jsonl`), "ask-auto-rejected-early-stop.stderr.txt",
    ].sort());
  });

  it.each(cases)("reduces %s to %s", (name, outcome, exitCode) => {
    const result = reduceOpencode({
      lines: read(`${name}.jsonl`), exitCode, timedOut: false,
      stderr: name === "ask-auto-rejected-early-stop" ? read(`${name}.stderr.txt`) : "",
    });
    expect(result.outcome).toBe(outcome);
    expect(result).toMatchSnapshot();
  });
});

describe("reduceOpencode", () => {
  it("sums step usage, counts starts, keeps the first session and last text with CRLF", () => {
    const events = [
      event("step_start"), event("text", { text: "earlier" }),
      event("step_finish", { reason: "tool-calls", tokens: { input: 100, output: 20, reasoning: 7, cache: { read: 30, write: 40 } }, cost: 0.25 }),
      event("step_start", {}, "later"), event("text", { text: "final" }, "later"),
      event("step_finish", { reason: "stop", tokens: { input: 200, output: 10, cache: { read: 50 } }, cost: 0.5 }, "later"),
    ];
    expect(reduce(events, { lines: events.map(e => JSON.stringify(e)).join("\r\n") + "\r\n" })).toEqual({
      outcome: "completed", sessionId: "first", resultText: "final",
      usage: { tokensIn: 300, tokensOut: 30, cachedInputTokens: 80, costUsd: 0.75, requests: 2 },
    });
  });

  it("classifies quota and converts Retry-After seconds to milliseconds", () => {
    expect(reduce([apiError(429, true, { "retry-after": "120" })], { exitCode: 1 })).toMatchObject({
      outcome: "quota", error: { statusCode: 429, isRetryable: true, retryAfterMs: 120000 },
    });
    expect(reduce([apiError(429, false, { "Retry-After": "2" })]).error?.retryAfterMs).toBe(2000);
  });

  it.each([401, 403])("classifies auth status %s", status => {
    expect(reduce([apiError(status)]).outcome).toBe("auth");
  });

  it.each([
    [500, false, "endpoint-unavailable"], [400, true, "endpoint-unavailable"],
    [401, true, "endpoint-unavailable"], [400, false, "failed"], [undefined, false, "failed"],
  ] as const)("classifies status %s / retryable %s", (status, retryable, outcome) => {
    expect(reduce([apiError(status, retryable)]).outcome).toBe(outcome);
  });

  it("prioritizes timeout, then quota, endpoint, auth and other errors over completion", () => {
    const events = [apiError(400), apiError(401), apiError(503, true), apiError(429), finish()];
    expect(reduce(events, { timedOut: true }).outcome).toBe("timedOut");
    expect(reduce(events).outcome).toBe("quota");
    expect(reduce(events.filter(e => e !== events[3])).outcome).toBe("endpoint-unavailable");
    expect(reduce(events.slice(0, 2)).outcome).toBe("auth");
  });

  it("recognizes spawn failure without events and timeout without output", () => {
    expect(reduce([], { exitCode: 127, stderr: "missing exe" })).toEqual({
      outcome: "spawn-failure", sessionId: null, resultText: "",
      usage: { tokensIn: 0, tokensOut: 0, cachedInputTokens: 0, costUsd: 0, requests: 0 },
    });
    expect(reduce([], { exitCode: 1, timedOut: true }).outcome).toBe("timedOut");
  });

  it("requires a final stop and checks stderr independently of the final reason", () => {
    expect(reduce([]).outcome).toBe("incomplete");
    expect(reduce([finish("tool-calls")]).outcome).toBe("incomplete");
    expect(reduce([finish(), finish("tool-calls")]).outcome).toBe("incomplete");
    expect(reduce([finish()], { stderr: "permission requested; auto-rejecting" }).outcome).toBe("incomplete");
  });

  it("ignores malformed lines and non-event JSON without inventing a session", () => {
    expect(reduce([], { lines: '\nnot json\r\nnull\n[]\n{}\n{"type":' }).outcome).toBe("incomplete");
    expect(reduce([], { lines: 'garbage\n{}\n', exitCode: 1 }).outcome).toBe("spawn-failure");
    expect(reduce([{ type: "step_start" }, finish()]).sessionId).toBeNull();
  });

  it("ignores invalid retry hints and tolerates missing error data", () => {
    for (const value of ["", "nonsense", "-2", "Infinity"]) {
      expect(reduce([apiError(429, false, { "retry-after": value })]).error).not.toHaveProperty("retryAfterMs");
    }
    expect(reduce([{ type: "error" }])).toMatchObject({ outcome: "failed", error: { statusCode: null, isRetryable: false } });
  });
});

describe("buildOpencodeArgv", () => {
  it("builds a fresh invocation with no message or resume flag", () => {
    expect(buildOpencodeArgv({ model: "opencode/model" })).toEqual(["run", "--format", "json", "-m", "opencode/model"]);
  });

  it("adds variant, explicit resume and title as individual argv entries", () => {
    expect(buildOpencodeArgv({ model: "provider/model", variant: "high", resumeSession: "ses_123", title: "issue 116" })).toEqual([
      "run", "--format", "json", "-m", "provider/model", "--variant", "high", "-s", "ses_123", "--title", "issue 116",
    ]);
    const fresh = buildOpencodeArgv({ model: "provider/model", title: "issue 116", variant: "minimal" });
    expect(fresh).not.toContain("-s");
    expect(fresh).not.toContain("--auto");
  });
});
