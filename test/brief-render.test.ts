import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import { loadPack } from "../src/pack/load.js";
import { renderPackBrief, storeBrief } from "../src/tasks/brief-render.js";
import { buildBrief } from "../src/tasks/brief.js";
import { loadDesignContext } from "../src/tasks/brief-context.js";
import { renderTicketBody } from "../src/tasks/plan-create.js";
import { resolvePlan, type Ticket } from "../src/tasks/plan.js";
import type { Issue } from "../src/github/github.js";

const pack = loadPack(resolve("test/fixtures/pack"));
const cfg = { ...DEFAULT_CONFIG, pack: pack.path, loadedPack: pack, verify: [["npm", "test"]] };
const ticket: Ticket = {
  id: "T1", title: "Implement damage", body: "Use the damage rule.\n\nExtra prose.", role: "gameplay-programmer", kind: "code",
  decisions: ["D-001"], context: ["combat.rules", "combat.large", "combat.small"], files: ["src/damage.ts", "design/spec.md"],
  locks: ["src/damage.ts"], acceptance: ["Damage test passes"], outOfScope: ["New classes"],
  verify: [["npm", "test", "--", "damage test.ts"]], budget: { minutes: 30, requests: 4 },
};
const issue = (value = ticket): Issue => ({ number: 174, title: value.title, body: renderTicketBody(value, []), labels: ["role:gameplay-programmer"], state: "OPEN", assignees: [] });

describe("pack brief rendering", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "orch-brief-"));
    vi.stubEnv("ORCH_HOME", join(cwd, ".orch"));
    mkdirSync(join(cwd, "design"));
    writeFileSync(join(cwd, "AGENTS.md"), "# Project\n\n## Conventions\nKeep deterministic.\n\n## Other\nNot standing.");
    writeFileSync(join(cwd, "studio.config.json"), JSON.stringify({ protected_paths: ["secrets/**"], roles: { "gameplay-programmer": { write_scope: ["src/**"] } } }));
    writeFileSync(join(cwd, "design/decisions.md"), "| ID | Decision | Status | Evidence | Date |\n| D-001 | Damage is deterministic. | decided | Tests | today |\n| D-002 | Old rule. | superseded | D-001 | today |");
    writeFileSync(join(cwd, "design/INDEX.md"), "| Anchor | File | Section |\n| combat.rules | combat.md | Rules |\n| combat.large | combat.md | Large |\n| combat.small | combat.md | Small |");
    writeFileSync(join(cwd, "design/combat.md"), "# Combat\n## Rules\nUse damage.\n### Nested\nKeep this too.\n## Large\n" + "x".repeat(6001) + "\n## Small\nSmall context.");
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(cwd, { recursive: true, force: true }); });

  it("renders the real template in its fixed order and stores separate attempts", () => {
    const rendered = renderPackBrief(issue(), cfg, cwd, "Previous report: partial. Reviewer: add damage test.");
    expect(rendered).toMatchSnapshot();
    expect(rendered).not.toContain("{{");
    expect(rendered).not.toContain("Extra prose.");
    expect(rendered).not.toContain("Not standing.");
    expect(rendered).not.toContain("x".repeat(6001));
    expect(rendered).toContain("combat.large: design/combat.md");
    const first = storeBrief(174, rendered, cwd);
    const second = storeBrief(174, "next", cwd);
    expect(first).toMatch(/briefs[\\/]issue-174-1.md$/);
    expect(second).toMatch(/briefs[\\/]issue-174-2.md$/);
    expect(readFileSync(first, "utf8")).toBe(rendered);
    expect(readFileSync(second, "utf8")).toBe("next");
  });

  it.each([
    [{ acceptance: [] }, /required ticket.acceptance/],
    [{ files: ["design/spec.md"] }, /required ticket.files/],
    [{ decisions: ["D-002"] }, /D-002 is superseded/],
    [{ decisions: ["D-999"] }, /unknown decision D-999/],
    [{ context: ["combat.missing"] }, /anchor combat.missing/],
  ])("refuses incomplete brief %j", (change, error) => {
    expect(() => renderPackBrief(issue({ ...ticket, ...change }), cfg, cwd)).toThrow(error);
  });

  it("rechecks section existence after an index entry goes stale", () => {
    writeFileSync(join(cwd, "design/combat.md"), "# Changed");
    expect(() => renderPackBrief(issue(), cfg, cwd)).toThrow(/missing section Rules/);
  });

  it("reports every rule 4 error with ticket id and field before creation", () => {
    const plan = resolvePlan([{ ...ticket, decisions: ["D-999", "D-002"], context: ["combat.missing"] }], { config: cfg, design: loadDesignContext(cwd) });
    expect(plan.errors).toEqual(expect.arrayContaining([
      'ticket 1 ("T1"): decisions: unknown decision D-999 in design/decisions.md',
      'ticket 1 ("T1"): decisions: D-002 is superseded',
      'ticket 1 ("T1"): context: anchor combat.missing does not resolve in design/INDEX.md',
    ]));
  });

  it("does not interpret placeholders inside untrusted ticket content", () => {
    expect(renderPackBrief(issue({ ...ticket, title: "Literal {{required ticket.fake}}" }), cfg, cwd)).toContain("Literal {{required ticket.fake}}");
  });

  it("keeps the legacy brief byte-identical", () => {
    const value = { ...issue(), title: "Legacy", body: "  The original issue body.  " };
    expect(buildBrief(value, { path: "/task", branch: "task/174" }, "codex", cwd)).toBe([
      "# Task #174: Legacy", "", "Agent:    codex", "Worktree: /task", "Branch:   task/174", "", "## Spec",
      "The original issue body.", "", "## Working agreement", "- Do all work inside the worktree above.",
      "- Read AGENTS.md at the repo root before starting; record durable facts there (not in native memory).",
      "- When done: `orch submit 174 --agent codex` — opens a PR and routes review to the other harness.", "",
    ].join("\n"));
  });

  it("caps cumulative inline context and keeps later short sections", () => {
    writeFileSync(join(cwd, "design/combat.md"), "## Rules\n" + "a".repeat(3500) + "\n## Large\n" + "b".repeat(3500) + "\n## Small\nShort.");
    const rendered = renderPackBrief(issue(), cfg, cwd);
    expect(rendered).toContain("a".repeat(3500));
    expect(rendered).not.toContain("b".repeat(3500));
    expect(rendered).toContain("combat.large: design/combat.md");
    expect(rendered).toContain("Short.");
  });
});
