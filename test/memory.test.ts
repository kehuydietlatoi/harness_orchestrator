import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addFact, listFacts } from "../src/memory.js";

describe("shared memory (AGENTS.md log)", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("appends facts under a ## Log section and lists them", () => {
    dir = mkdtempSync(join(tmpdir(), "orch-mem-"));
    writeFileSync(join(dir, "AGENTS.md"), "# Memory\n\n## Conventions\n");
    addFact("use squash merges", "decision", dir);
    addFact("watch out for BOM", "gotcha", dir);

    const facts = listFacts(dir);
    expect(facts).toHaveLength(2);
    expect(facts[0]).toContain("[decision] use squash merges");
    expect(facts[1]).toContain("[gotcha] watch out for BOM");
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("## Log");
  });

  it("throws when AGENTS.md is missing", () => {
    dir = mkdtempSync(join(tmpdir(), "orch-mem-"));
    expect(() => addFact("x", "note", dir)).toThrow(/AGENTS\.md/);
  });
});
