import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { availabilityPath, markUnavailable } from "../src/board/availability.js";
import { assertSelfReviewAllowed, pickReviewer } from "../src/board/reviewer.js";
import { DEFAULT_CONFIG, type OrchConfig } from "../src/config.js";

const agents = ["claude", "codex"];
const none = new Set<string>();

describe("pickReviewer", () => {
  it("prefers the other harness", () => {
    expect(pickReviewer({ author: "claude", agents, policy: "cross-or-self", unavailable: none }))
      .toEqual({ reviewer: "codex", mode: "cross" });
    expect(pickReviewer({ author: "codex", agents, policy: "cross", unavailable: none }))
      .toEqual({ reviewer: "claude", mode: "cross" });
  });

  it("falls back to a self-review only when the other harness is unavailable and policy allows", () => {
    const codexDown = new Set(["codex"]);
    expect(pickReviewer({ author: "claude", agents, policy: "cross-or-self", unavailable: codexDown }))
      .toEqual({ reviewer: "claude", mode: "self" });
    expect(pickReviewer({ author: "claude", agents, policy: "cross", unavailable: codexDown })).toBeNull();
  });

  it("returns null when nobody can review", () => {
    expect(pickReviewer({ author: "claude", agents, policy: "cross-or-self", unavailable: new Set(agents) })).toBeNull();
  });

  it("never offers self-review for an unknown author", () => {
    expect(pickReviewer({ author: null, agents, policy: "cross-or-self", unavailable: none }))
      .toEqual({ reviewer: "claude", mode: "cross" });
    expect(pickReviewer({ author: "ghost", agents, policy: "cross-or-self", unavailable: new Set(agents) })).toBeNull();
  });
});

describe("assertSelfReviewAllowed", () => {
  let cwd = "";
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "orch-reviewer-"));
  });
  afterEach(() => {
    rmSync(dirname(availabilityPath(cwd)), { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("refuses while the other harness is available", () => {
    expect(() => assertSelfReviewAllowed("claude", DEFAULT_CONFIG, cwd)).toThrow(/only a fallback.*'codex' is available/);
  });

  it("allows once every other harness is on cooldown", () => {
    markUnavailable("codex", { resetAt: null, reason: "usage limit" }, cwd);
    expect(() => assertSelfReviewAllowed("claude", DEFAULT_CONFIG, cwd)).not.toThrow();
  });

  it("refuses when the policy is cross, even during a cooldown", () => {
    markUnavailable("codex", { resetAt: null, reason: "usage limit" }, cwd);
    const cfg: OrchConfig = { ...DEFAULT_CONFIG, reviewPolicy: "cross" };
    expect(() => assertSelfReviewAllowed("claude", cfg, cwd)).toThrow(/disabled/);
  });

  it("allows a single-harness setup, which has no other reviewer", () => {
    const cfg: OrchConfig = { ...DEFAULT_CONFIG, agents: ["claude"] };
    expect(() => assertSelfReviewAllowed("claude", cfg, cwd)).not.toThrow();
  });
});
