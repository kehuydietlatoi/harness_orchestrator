import { afterEach, expect, it, vi } from "vitest";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { doctorCommand } from "../src/commands/doctor.js";
import { commandExists } from "../src/util/exec.js";

vi.mock("../src/util/exec.js", () => ({ commandExists: vi.fn(async () => true) }));
vi.mock("../src/git/git.js", () => ({ isGitRepo: vi.fn(async () => true), gitVersion: vi.fn(async () => "2.50"),
  supportsWorktree: vi.fn(async () => true), remoteUrl: vi.fn(async () => "https://github.com/test/repo") }));
vi.mock("../src/github/github.js", async () => {
  const { LABELS } = await import("../src/github/labels.js");
  return { ghInstalled: vi.fn(async () => true), ghAuthenticated: vi.fn(async () => true),
    listLabels: vi.fn(async () => LABELS.map((label) => label.name)), listIssues: vi.fn(async () => []), getIssue: vi.fn() };
});
vi.mock("../src/board/snapshot.js", () => ({ buildSnapshot: vi.fn(async () => ({ tasks: [] })), healthDetail: vi.fn() }));

const originalCwd = process.cwd();
let dir: string;
afterEach(() => {
  process.chdir(originalCwd);
  if (dir) rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
  vi.restoreAllMocks();
});
it.each(["missing-directory", "missing-prompt", "malformed", "valid"])("doctor checks the pack: %s", async (mode) => {
  dir = mkdtempSync(join(tmpdir(), "orch-doctor-"));
  cpSync(resolve("test/fixtures/pack"), join(dir, ".studio"), { recursive: true });
  if (mode === "missing-prompt") rmSync(join(dir, ".studio/roles/explorer.md"));
  if (mode === "malformed") writeFileSync(join(dir, ".studio/roles/explorer.json"), "{");
  writeFileSync(join(dir, "orch.config.json"), JSON.stringify({ pack: mode === "missing-directory" ? "absent" : ".studio" }));
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  process.chdir(dir);
  await doctorCommand();
  expect(process.exitCode).toBe(mode === "valid" ? 0 : 1);
  expect(output.mock.calls.flat().join("\n")).toContain("config and domain pack valid");
  if (mode === "missing-prompt" || mode === "malformed") expect(output.mock.calls.flat().join("\n")).toContain("explorer.json");
});

it("reports a missing evidence executable", async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-doctor-"));
  writeFileSync(join(dir, "orch.config.json"), JSON.stringify({ evidence: ["missing-evidence", "runner.mjs"] }));
  vi.mocked(commandExists).mockImplementation(async cmd => cmd !== "missing-evidence");
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  process.chdir(dir);
  await doctorCommand();
  expect(commandExists).toHaveBeenCalledWith("missing-evidence");
  expect(output.mock.calls.flat().join("\n")).toMatch(/evidence command present.*missing-evidence/);
  expect(process.exitCode).toBe(1);
});
