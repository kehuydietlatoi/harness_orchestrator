import { describe, expect, it } from "vitest";
import { parseUsage } from "../src/telemetry.js";

describe("parseUsage", () => {
  it("extracts Claude result usage, cache input, and cost", () => {
    const log = [
      JSON.stringify({ type: "assistant", message: { content: [] } }),
      JSON.stringify({
        type: "result",
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 10,
        },
        total_cost_usd: 0.0123,
      }),
    ].join("\n");

    expect(parseUsage(log, "claude")).toEqual({
      tokensIn: 150,
      tokensOut: 25,
      tokensTotal: 175,
      costUsd: 0.0123,
    });
  });

  it("extracts a modern Codex turn usage event without double-counting cached input", () => {
    const log = [
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 30 },
      }),
    ].join("\n");

    expect(parseUsage(log, "codex")).toEqual({
      tokensIn: 120,
      tokensOut: 30,
      tokensTotal: 150,
      costUsd: null,
    });
  });

  it("extracts nested token_count totals emitted by older Codex versions", () => {
    const log = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 200, output_tokens: 50, total_tokens: 250 },
          last_token_usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
        },
      },
    });

    expect(parseUsage(log, "codex")).toEqual({
      tokensIn: 200,
      tokensOut: 50,
      tokensTotal: 250,
      costUsd: null,
    });
  });

  it("returns null usage when no usage is present", () => {
    expect(parseUsage('{"type":"turn.completed"}\nplain text', "codex")).toEqual({
      tokensIn: null,
      tokensOut: null,
      tokensTotal: null,
      costUsd: null,
    });
  });

  it("ignores malformed and mixed lines without throwing", () => {
    const log = [
      "not json",
      "{broken",
      JSON.stringify({ type: "notice", usage: { input_tokens: "unknown" } }),
      JSON.stringify({ type: "token_count", input_tokens: 7 }),
      "[]",
    ].join("\r\n");

    expect(() => parseUsage(log, "codex")).not.toThrow();
    expect(parseUsage(log, "codex")).toEqual({
      tokensIn: 7,
      tokensOut: null,
      tokensTotal: null,
      costUsd: null,
    });
  });
});
