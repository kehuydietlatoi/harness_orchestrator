import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
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

  it("serves the workflow graph and scenario registry in demo mode", async () => {
    // Reserve an OS-selected port, then release it for the real CLI server.
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("No TCP port allocated");
    const port = address.port;
    await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
    const child = spawn(process.execPath, [cli, "serve", "--demo", "--port", String(port)], {
      cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    let output = "";
    let errors = "";
    child.stderr.on("data", (chunk) => { errors += chunk.toString(); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Demo server did not start: ${errors}`)), 15_000);
        const ready = () => { clearTimeout(timeout); resolve(); };
        child.once("error", (error) => { clearTimeout(timeout); reject(error); });
        child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Demo server exited ${code}: ${errors}`)); });
        child.stdout.on("data", (chunk) => {
          output += chunk.toString();
          if (output.includes(`Dashboard: http://127.0.0.1:${port}`)) ready();
        });
      });
      const base = `http://127.0.0.1:${port}`;
      const flowResponse = await fetch(`${base}/flow`);
      expect(flowResponse.status).toBe(200);
      const graph = await flowResponse.json();
      expect(graph.nodes.length).toBeGreaterThan(0);
      expect(graph.edges.length).toBeGreaterThan(0);
      expect(graph.flows.length).toBeGreaterThan(0);
      expect(graph.lanes.length).toBeGreaterThan(0);
      expect(graph.stepNodes.review).toBe("step.review");
      expect(graph.stateNodes.ready).toBe("state.ready");
      const scenariosResponse = await fetch(`${base}/demo/scenarios`);
      expect(scenariosResponse.status).toBe(200);
      const player = await scenariosResponse.json();
      expect(player.scenarios.length).toBeGreaterThan(0);
      expect(player.scenarios[0]).toEqual(expect.objectContaining({
        id: expect.any(String), title: expect.any(String), frameCount: expect.any(Number),
      }));
      expect(player.current).toEqual({ scenarioId: null, index: 0, total: 0, frame: null });
    } finally {
      child.kill();
      await closed;
    }
  });

  it("previews hard and advisory ticket references separately through the built CLI", () => {
    const { code, stdout, stderr } = runCli(["plan", "--dry-run", "test/fixtures/advisory-tickets.json"]);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("deps:api");
    expect(stdout).toContain("after (advisory):docs");
    expect(stdout).not.toContain("warning:");
  });
});
