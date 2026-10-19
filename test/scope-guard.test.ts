import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { loadPack } from "../src/pack/load.js";
import { issueScope, scopeViolations, ticketFiles } from "../src/tasks/scope-guard.js";

const role = { write_scope: ["src/**"], forbidden: ["src/private/**", "design/**"] };

describe("scopeViolations", () => {
  it.each([
    { path: "src/main.ts", files: [], reason: null },
    { path: "README.md", files: ["README.md"], reason: null },
    { path: "docs/guide.md", files: ["docs/**"], reason: null },
    { path: "other.ts", files: [], reason: "outside write_scope" },
    { path: "src/private/key.ts", files: [], reason: "forbidden by src/private/**" },
    { path: "design/game.md", files: ["design/**"], reason: "forbidden by design/**" },
  ])("checks $path with ticket files $files", ({ path, files, reason }) => {
    expect(scopeViolations([path], role, files)).toEqual(reason ? [{ path, reason }] : []);
  });

  it("checks rename source and destination and deleted names, preserving unusual filenames", () => {
    expect(scopeViolations(["src/old.ts", "elsewhere/new.ts", "design/deleted.md", "bad\nname.ts"], role)).toEqual([
      { path: "elsewhere/new.ts", reason: "outside write_scope" },
      { path: "design/deleted.md", reason: "forbidden by design/**" },
      { path: "bad\nname.ts", reason: "outside write_scope" },
    ]);
  });

  it("reads the canonical ticket files projection", () => {
    expect(ticketFiles("**Files (ownership hint):** `README.md`, `docs/**`\n")).toEqual(["README.md", "docs/**"]);
  });

  it("is disabled without a pack or role label; unknown pack roles fail closed", () => {
    const pack = loadPack("test/fixtures/pack");
    const issue = { number: 1, title: "t", body: "", state: "OPEN", labels: ["role:gameplay-programmer"], assignees: [] };
    expect(issueScope(issue, { ...DEFAULT_CONFIG, loadedPack: pack })).toBeUndefined();
    expect(issueScope({ ...issue, labels: [] }, { ...DEFAULT_CONFIG, pack: pack.path, loadedPack: pack })).toBeUndefined();
    expect(() => issueScope(issue, { ...DEFAULT_CONFIG, pack: pack.path })).toThrow(/unavailable/);
  });
});
