import { describe, expect, it } from "vitest";
import { detectUsageLimit, nextClockTime } from "../src/adapters/usage-limit.js";

// Real Codex failure lines captured from logs/issue-66.jsonl.
const CODEX_MSG =
  "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:33 PM.";
const codexLog =
  '{"type":"thread.started","thread_id":"abc"}\n' +
  `{"type":"error","message":${JSON.stringify(CODEX_MSG)}}\n` +
  `{"type":"turn.failed","error":{"message":${JSON.stringify(CODEX_MSG)}}}\n`;

const noon = new Date(2026, 9, 6, 12, 0, 0);

describe("nextClockTime", () => {
  it("resolves a later wall-clock time to today, local time", () => {
    const at = new Date(nextClockTime("try again at 4:33 PM.", noon) as string);
    expect([at.getHours(), at.getMinutes(), at.getDate()]).toEqual([16, 33, 6]);
  });

  it("rolls an already-passed time over to tomorrow", () => {
    const at = new Date(nextClockTime("resets 9am", noon) as string);
    expect([at.getHours(), at.getDate()]).toEqual([9, 7]);
  });

  it("handles 12 AM / 12 PM and returns null without a clock time", () => {
    expect(new Date(nextClockTime("try again at 12:00 AM", noon) as string).getHours()).toBe(0);
    expect(new Date(nextClockTime("try again at 12 PM", new Date(2026, 9, 6, 11, 0)) as string).getHours()).toBe(12);
    expect(nextClockTime("try again later", noon)).toBeNull();
  });
});

describe("detectUsageLimit", () => {
  it("recognises a Codex usage-limit failure and its reset time", () => {
    const limit = detectUsageLimit(codexLog, noon);
    expect(limit?.message).toContain("hit your usage limit");
    expect(new Date(limit?.resetAt as string).getHours()).toBe(16);
  });

  it("recognises a rejected Claude rate_limit_event using its epoch resetsAt", () => {
    const log = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1787686200,"rateLimitType":"five_hour"}}';
    const limit = detectUsageLimit(log, noon);
    expect(limit?.resetAt).toBe(new Date(1787686200 * 1000).toISOString());
    expect(limit?.message).toContain("five_hour");
  });

  it("recognises an is_error Claude result naming the limit", () => {
    const log = '{"type":"result","is_error":true,"result":"5-hour limit reached ∙ resets 3pm"}';
    const limit = detectUsageLimit(log, noon);
    expect(new Date(limit?.resetAt as string).getHours()).toBe(15);
  });

  it("returns a limit with no reset time when the message names none", () => {
    const log = '{"type":"error","message":"rate limit exceeded"}';
    expect(detectUsageLimit(log, noon)).toEqual({ resetAt: null, message: "rate limit exceeded" });
  });

  it("ignores an allowed Claude rate_limit_event", () => {
    const log = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1787686200}}';
    expect(detectUsageLimit(log, noon)).toBeNull();
    const warning = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning"}}';
    expect(detectUsageLimit(warning, noon)).toBeNull();
  });

  it("never treats ordinary assistant text about rate limits as a refusal", () => {
    const log =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"I added a usage limit and rate limit check"}]}}\n' +
      '{"type":"result","is_error":false,"result":"Implemented the rate limit feature"}\n' +
      "plain text: You have hit your usage limit\n";
    expect(detectUsageLimit(log, noon)).toBeNull();
  });

  it("returns null for empty and malformed logs", () => {
    expect(detectUsageLimit("", noon)).toBeNull();
    expect(detectUsageLimit("{not json\n{\"type\":", noon)).toBeNull();
  });
});
