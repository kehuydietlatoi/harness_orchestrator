import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// Exercise the real published entrypoint end to end: compile src -> dist, then
// run `node dist/cli.js ...` as a subprocess. This is the one test that would
// catch a broken build, a missing bin, or a src change that never reached dist
// (the stale-dist class of bug), which every mocked unit test is blind to.

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const cli = path.join(repoRoot, "dist", "cli.js");
const tsc = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");

/** Run the built CLI, returning { code, stdout, stderr } without throwing. */
function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("built CLI smoke", () => {
  beforeAll(() => {
    // Always compile fresh so the test reflects the current source, never a
    // stale dist left over from an earlier build.
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: repoRoot, stdio: "inherit" });
    expect(existsSync(cli), "dist/cli.js should exist after build").toBe(true);
  });

  it("prints usage and the core commands on --help", () => {
    const { code, stdout } = runCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Usage:\s+orch/);
    for (const command of ["next", "submit", "serve", "plan", "doctor", "run"]) {
      expect(stdout, `--help should list "${command}"`).toContain(command);
    }
  });

  it("exits non-zero on an unknown command", () => {
    const { code } = runCli(["definitely-not-a-real-command"]);
    expect(code).not.toBe(0);
  });
});
