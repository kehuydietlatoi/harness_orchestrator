import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, resolveFamily } from "../src/config.js";
import { issueRole, validateRoute } from "../src/routing/route-policy.js";

const cfg = { ...DEFAULT_CONFIG, roles: { coder: { tiers: ["lead" as const], families: ["openai"] } } };

describe("validateRoute", () => {
  it("accepts allowed tiers and families, rejecting each independently", () => {
    expect(validateRoute({ role: "coder", agent: "codex", tier: "lead" }, cfg)).toEqual({ ok: true });
    expect(validateRoute({ role: "coder", agent: "codex", tier: "standard" }, cfg)).toMatchObject({ ok: false, reason: expect.stringContaining("tier 'standard'") });
    expect(validateRoute({ role: "coder", agent: "claude", tier: "lead" }, cfg)).toMatchObject({ ok: false, reason: expect.stringContaining("family 'anthropic'") });
  });
  it("never rejects an issue without a role, including an unknown provider", () => {
    expect(validateRoute({ role: issueRole({ labels: ["status:todo"] }), agent: "custom", tier: "standard" }, cfg)).toEqual({ ok: true });
  });
  it("fails closed for unknown roles and unknown families", () => {
    expect(validateRoute({ role: "missing", agent: "codex", tier: "lead" }, cfg).ok).toBe(false);
    expect(validateRoute({ role: "toString", agent: "codex", tier: "lead" }, cfg).ok).toBe(false);
    expect(validateRoute({ role: "coder", agent: "custom", tier: "lead" }, cfg).ok).toBe(false);
  });
  it("uses the selected model's family override", () => {
    const custom = { ...cfg, adapters: { claude: { cmd: "claude", family: "anthropic", models: { standard: {}, lead: { family: "openai" } } } } };
    expect(validateRoute({ role: "coder", agent: "claude", tier: "lead" }, custom)).toEqual({ ok: true });
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
