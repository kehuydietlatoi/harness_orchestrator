import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, resolveTierModel, type CascadeRoute, type OrchConfig } from "../src/config.js";
import { nextHop } from "../src/tasks/cascade.js";
import { reviewIdentity } from "../src/board/review-identity.js";

const a: CascadeRoute = { agent: "opencode", tier: "free", model: "zen/a", family: "a" };
const b: CascadeRoute = { ...a, model: "zen/b", family: "b" };
const c: CascadeRoute = { ...a, tier: "cheap", model: "zen/c" };
const d: CascadeRoute = { ...a, tier: "standard", model: "zen/d" };
const cfg: OrchConfig = {
  ...DEFAULT_CONFIG, agents: [...DEFAULT_CONFIG.agents, "opencode"],
  adapters: { ...DEFAULT_CONFIG.adapters, opencode: { cmd: "opencode" } },
  tierMembers: { free: [a, b], cheap: [c], standard: [d], lead: [] },
  roles: { coder: { tiers: ["free", "standard"], families: ["a"] } },
};

describe("nextHop", () => {
  it("skips secret and internal OpenCode members and respects needs", () => {
    const claude: CascadeRoute = { agent: "claude", tier: "standard" };
    const codex: CascadeRoute = { agent: "codex", tier: "cheap" };
    const policy = { ...cfg, tierMembers: { ...cfg.tierMembers!, cheap: [c, codex], standard: [d, claude] } };
    expect(nextHop(a, [], undefined, policy, undefined, { sensitivity: "secret" })).toEqual({ ...DEFAULT_CONFIG.adapters.codex.models!.cheap, ...codex });
    expect(nextHop(a, [], undefined, { ...policy, sensitivity: { internal: { allow: ["zen/c"] } } }, undefined, { sensitivity: "internal" })).toEqual(c);
    expect(nextHop(a, [], undefined, policy, undefined, { needs: ["vision"] })).toEqual({ ...DEFAULT_CONFIG.adapters.codex.models!.cheap, ...codex });
    expect(nextHop(a, [], undefined, policy, undefined, { needs: ["web"] })).toBeNull();
  });
  it.each([
    ["same-tier next member", a, [], undefined, b],
    ["next tier up", b, [], undefined, c],
    ["skips tried members", a, [b], undefined, c],
    ["skips disallowed families and tiers", a, [], "coder", d],
    ["never lower or back to earlier members", d, [], undefined, null],
    ["unknown role fails closed", a, [], "unknown", null],
    ["exhausted", c, [d], undefined, null],
  ] as const)("%s", (_name, current, tried, role, expected) => {
    expect(nextHop(current, tried, role, cfg)).toEqual(expected);
  });

  it("preserves retry/wait without an explicit ladder", () => {
    expect(nextHop(a, [], undefined, DEFAULT_CONFIG)).toBeNull();
  });

  it.each([
    ["skips a cooled member", ["zen/b"], c],
    ["skips across tiers", ["zen/b", "zen/c"], d],
    ["exhausts available members", ["zen/b", "zen/c", "zen/d"], null],
    ["keeps an available member", ["zen/c"], b],
  ] as const)("%s", (_name, cooled, expected) => {
    expect(nextHop(a, [], undefined, cfg, member => !new Set<string>(cooled).has(member.model!))).toEqual(expected);
  });

  it("resolves inherited defaults when matching the current member", () => {
    const custom = { ...DEFAULT_CONFIG, tierMembers: { free: [], cheap: [], standard: [], lead: [{ agent: "codex" }, { agent: "claude" }] } };
    expect(nextHop({ agent: "codex", tier: "lead" }, [], undefined, custom)?.agent).toBe("claude");
  });

  it("resolves the projected member's effort and family for the next run", () => {
    const custom = { ...cfg, tierMembers: { ...cfg.tierMembers!, free: [a, { ...b, effort: "high" }] } };
    expect(resolveTierModel("opencode", "free", custom, ["model:zen/b"])).toEqual({ model: "zen/b", family: "b", effort: "high" });
    expect(() => resolveTierModel("opencode", "free", custom, ["model:unknown"])).toThrow(/Unknown model/);
    const issue = { number: 1, title: "", body: "", state: "OPEN" as const, labels: ["agent:opencode", "effort:free", "model:zen/b"], assignees: [] };
    expect(reviewIdentity("opencode", issue, custom, "author").family).toBe("b");
    expect(reviewIdentity("claude", issue, custom)).toMatchObject({ tier: "standard", family: "anthropic" });
  });
});
