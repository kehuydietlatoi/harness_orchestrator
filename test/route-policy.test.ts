import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, resolveFamily } from "../src/config.js";
import { issueRole, validateRoute } from "../src/routing/route-policy.js";

const cfg = { ...DEFAULT_CONFIG, roles: { coder: { tiers: ["hard" as const], families: ["openai"] } } };

describe("validateRoute", () => {
  it("accepts allowed tiers and families, rejecting each independently", () => {
    expect(validateRoute({ role: "coder", agent: "codex", tier: "hard" }, cfg)).toEqual({ ok: true });
    expect(validateRoute({ role: "coder", agent: "codex", tier: "easy" }, cfg)).toMatchObject({ ok: false, reason: expect.stringContaining("tier 'easy'") });
    expect(validateRoute({ role: "coder", agent: "claude", tier: "hard" }, cfg)).toMatchObject({ ok: false, reason: expect.stringContaining("family 'anthropic'") });
  });
  it("never rejects an issue without a role, including an unknown provider", () => {
    expect(validateRoute({ role: issueRole({ labels: ["status:todo"] }), agent: "custom", tier: "easy" }, cfg)).toEqual({ ok: true });
  });
  it("fails closed for unknown roles and unknown families", () => {
    expect(validateRoute({ role: "missing", agent: "codex", tier: "hard" }, cfg).ok).toBe(false);
    expect(validateRoute({ role: "toString", agent: "codex", tier: "hard" }, cfg).ok).toBe(false);
    expect(validateRoute({ role: "coder", agent: "custom", tier: "hard" }, cfg).ok).toBe(false);
  });
  it("uses the selected model's family override", () => {
    const custom = { ...cfg, adapters: { claude: { cmd: "claude", family: "anthropic", models: { easy: {}, hard: { family: "openai" } } } } };
    expect(validateRoute({ role: "coder", agent: "claude", tier: "hard" }, custom)).toEqual({ ok: true });
  });
});

describe("resolveFamily", () => {
  it("resolves model overrides, adapter defaults, and built-in families", () => {
    expect(resolveFamily("codex", { family: "other" }, cfg)).toBe("other");
    expect(resolveFamily("custom", {}, { adapters: { custom: { cmd: "c", family: "provider" } } })).toBe("provider");
    expect(resolveFamily("claude", undefined, {})).toBe("anthropic");
    expect(resolveFamily("codex", undefined, {})).toBe("openai");
    expect(resolveFamily("custom", undefined, {})).toBeUndefined();
    expect(resolveFamily("opencode", {}, { adapters: { opencode: { cmd: "o", family: "ignored" } } })).toBeUndefined();
  });
});
