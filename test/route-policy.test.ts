import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, resolveFamily } from "../src/config.js";
import { issueRole, validateRoute } from "../src/routing/route-policy.js";

const cfg = { ...DEFAULT_CONFIG, roles: { coder: { tiers: ["lead" as const], families: ["openai"] } } };

describe("validateRoute", () => {
  it("filters secret routes by family and always excludes OpenCode", () => {
    expect(validateRoute({ agent: "claude", tier: "lead", sensitivity: "secret" }, cfg).ok).toBe(true);
    expect(validateRoute({ agent: "codex", tier: "lead", sensitivity: "secret" }, { ...cfg, sensitivity: { secret: { families: ["anthropic"] } } }).ok).toBe(false);
    expect(validateRoute({ agent: "opencode", tier: "lead", sensitivity: "secret", model: { model: "zen/a", family: "openai" } }, cfg).ok).toBe(false);
  });
  it("requires explicit model allow-listing for internal OpenCode even for an allowed family", () => {
    const route = { agent: "opencode", tier: "lead" as const, sensitivity: "internal" as const, model: { model: "zen/a", family: "openai" } };
    expect(validateRoute(route, cfg).ok).toBe(false);
    expect(validateRoute(route, { ...cfg, sensitivity: { internal: { allow: ["zen/a"] } } }).ok).toBe(true);
    expect(validateRoute({ ...route, model: { model: "zen/b", family: "openai" } }, { ...cfg, sensitivity: { internal: { allow: ["zen/a"] } } }).ok).toBe(false);
  });
  it("defaults opted-in tickets to internal and honors configured default", () => {
    const route = { agent: "opencode", tier: "lead" as const, model: { model: "zen/a", family: "other" } };
    expect(validateRoute({ ...route, needs: ["shell"] }, cfg).ok).toBe(false);
    expect(validateRoute(route, { ...cfg, sensitivity: { default: "public" } }).ok).toBe(true);
    expect(validateRoute(route, { ...cfg, sensitivity: { default: "internal" } }).ok).toBe(false);
  });
  it("checks capabilities on the selected member, including empty overrides", () => {
    expect(validateRoute({ agent: "claude", tier: "lead", needs: ["vision"] }, cfg).ok).toBe(true);
    expect(validateRoute({ agent: "codex", tier: "lead", needs: ["vision"] }, cfg).ok).toBe(true);
    expect(validateRoute({ agent: "codex", tier: "lead", needs: ["vision"], model: { capabilities: ["shell"] } }, cfg).ok).toBe(false);
    expect(validateRoute({ agent: "opencode", tier: "lead", needs: ["vision"], sensitivity: "public" }, cfg).ok).toBe(false);
    expect(validateRoute({ agent: "claude", tier: "lead", needs: ["shell"], model: { capabilities: [] } }, cfg).ok).toBe(false);
    expect(validateRoute({ agent: "codex", tier: "lead", needs: ["vision"], model: { capabilities: ["vision"] } }, cfg).ok).toBe(true);
  });
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
