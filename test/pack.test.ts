import { afterEach, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadPack } from "../src/pack/load.js";
import { loadConfig } from "../src/config.js";
import { resolvePlan, type Ticket } from "../src/tasks/plan.js";
import { createFromPlan } from "../src/tasks/plan-create.js";
import { validateRoute } from "../src/routing/route-policy.js";

const fixture = resolve("test/fixtures/pack");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function project(overrides = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "orch-pack-"));
  dirs.push(cwd);
  cpSync(fixture, join(cwd, ".studio"), { recursive: true });
  writeFileSync(join(cwd, "orch.config.json"), JSON.stringify({ pack: ".studio", verify: [["npm", "test"]], ...overrides }));
  return cwd;
}

describe("domain packs", () => {
  it("loads real manifests and exact Markdown prompts", () => {
    const pack = loadPack(fixture);
    expect(Object.keys(pack.roles)).toEqual(["asset-artist", "explorer", "gameplay-programmer"]);
    expect(pack.roles.explorer.manifest.read_only).toBe(true);
    expect(pack.roles.explorer.prompt).toBe(readFileSync(join(fixture, "roles/explorer.md"), "utf8"));
  });
  it("names every broken manifest and missing prompt", () => {
    const cwd = project();
    writeFileSync(join(cwd, ".studio/roles/explorer.json"), "{");
    rmSync(join(cwd, ".studio/roles/asset-artist.md"));
    expect(() => loadPack(".studio", cwd)).toThrow(/asset-artist.json.*asset-artist.md.*explorer.json/);
  });
  it.each([
    { tiers: ["easy"] }, { families: "openai" }, { id: "wrong" }, { prompt: "../outside.md" },
  ])("rejects malformed manifest fields %j with a filename", (override) => {
    const cwd = project();
    const path = join(cwd, ".studio/roles/explorer.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...override }));
    expect(() => loadConfig(cwd)).toThrow(/explorer.json/);
  });
  it("feeds routing and lets config replace a pack allowance", () => {
    const cfg = loadConfig(project({ roles: { explorer: { tiers: ["lead"], families: ["anthropic"] } } }));
    expect(validateRoute({ role: "gameplay-programmer", agent: "codex", tier: "cheap" }, cfg).ok).toBe(false);
    expect(validateRoute({ role: "gameplay-programmer", agent: "codex", tier: "standard" }, cfg).ok).toBe(true);
    expect(validateRoute({ role: "explorer", agent: "claude", tier: "lead" }, cfg).ok).toBe(true);
    expect(validateRoute({ role: "explorer", agent: "codex", tier: "lead" }, cfg).ok).toBe(false);
    expect(validateRoute({ role: "explorer", agent: "claude", tier: "cheap" }, cfg).ok).toBe(false);
  });
  it("reports required fields together, with ticket id, only when pack is set", async () => {
    const cfg = loadConfig(project());
    const tickets = [{ id: "T1", title: "Implement rule" }];
    expect(resolvePlan(tickets).errors).toEqual([]);
    const { errors } = resolvePlan(tickets, { config: cfg });
    expect(errors).toHaveLength(3);
    for (const field of ["role", "kind", "verify"]) expect(errors).toContain(`ticket 1 ("T1"): ${field} is required when pack is configured`);
    await expect(createFromPlan(tickets, "unused", undefined, { config: cfg })).rejects.toThrow(/invalid tickets/);
  });
  it("checks tier, resolved provider family, and actual pack membership", () => {
    const cfg = loadConfig(project({ roles: { custom: { tiers: ["standard"], families: ["openai"] } },
      adapters: { codex: { models: { standard: { family: "other" } } } } }));
    const valid: Ticket = { title: "Implement rule", role: "gameplay-programmer", kind: "code", verify: [["npm", "test"]] };
    expect(resolvePlan([valid], { config: cfg }).errors).toEqual([]);
    for (const ticket of [{ ...valid, effort: "cheap" }, { ...valid, agent: "codex", effort: "standard" },
      { ...valid, role: "custom" }, { ...valid, agent: "unknown" }, { ...valid, effort: "bogus" }]) {
      expect(resolvePlan([ticket], { config: cfg }).errors.length).toBeGreaterThan(0);
      expect(resolvePlan([ticket], { config: { ...cfg, pack: undefined } }).errors).toEqual([]);
    }
  });
});
