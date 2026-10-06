import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));

it("packs reproducibly, excludes private files, and installs a working CLI with assets", () => {
  const npmCli = process.env.ORCH_TEST_NPM_CLI ?? process.env.npm_execpath;
  if (!npmCli || !existsSync(npmCli)) throw new Error("Run via npm run test:e2e or set ORCH_TEST_NPM_CLI to npm-cli.js");
  const temp = mkdtempSync(path.join(tmpdir(), "orch-package-"));
  const fixture = path.join(temp, "source");
  const installed = path.join(temp, "consumer");
  mkdirSync(fixture);
  mkdirSync(installed);
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const npmBin = path.join(path.dirname(path.dirname(path.dirname(npmCli))), ".bin");
  env[pathKey] = [path.dirname(process.execPath), npmBin, env[pathKey]].join(path.delimiter);
  const npm = (cwd: string, args: string[]) => execFileSync(process.execPath, [npmCli, ...args], {
    cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 90_000,
  });
  try {
    for (const file of ["package.json", "package-lock.json", "tsconfig.json", "src", "public", "assets", "docs", "README.md", "LICENSE", "CONTEXT.md", "demo.md", "tickets.example.json"]) {
      cpSync(path.join(root, file), path.join(fixture, file), { recursive: true });
    }
    symlinkSync(path.join(root, "node_modules"), path.join(fixture, "node_modules"), "junction");
    for (const file of [".claude/settings.local.json", ".env", "private-key.pem", "test/private.txt"]) {
      mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
      writeFileSync(path.join(fixture, file), "PRIVATE_SENTINEL");
    }
    mkdirSync(path.join(fixture, "dist"));
    writeFileSync(path.join(fixture, "dist/cli.js"), "throw new Error('stale build');");
    const pack = () => JSON.parse(npm(fixture, ["pack", "--json", "--pack-destination", temp]))[0] as {
      filename: string; integrity: string; files: Array<{ path: string }>;
    };
    const first = pack();
    expect(pack().integrity).toBe(first.integrity);
    const files = first.files.map((f) => f.path);
    for (const file of ["dist/cli.js", "public/index.html", "assets/skills/orch-plan/SKILL.md", "tickets.example.json", "docs/WORKFLOW.md"]) {
      expect(files).toContain(file);
    }
    expect(files.some((f) => /^(?:src\/|test\/|node_modules\/|\.claude\/|\.env|private-key)/.test(f))).toBe(false);
    for (const file of files) {
      expect(/^(?:dist\/|public\/|assets\/|docs\/|README.md$|LICENSE$|package.json$|tickets.example.json$|demo.md$|CONTEXT.md$)/.test(file), file).toBe(true);
    }
    npm(installed, ["install", path.join(temp, first.filename), "--no-audit", "--no-fund", "--ignore-scripts"]);
    const packageRoot = path.join(installed, "node_modules/harness-orchestrator");
    const output = execFileSync(process.execPath, [path.join(packageRoot, "dist/cli.js"), "--help"], { encoding: "utf8", cwd: installed });
    expect(output).toContain("Usage: orch");
    expect(readFileSync(path.join(packageRoot, "assets/skills/orch-plan/SKILL.md"), "utf8")).toContain("tickets.json");
    expect(readFileSync(path.join(packageRoot, "public/index.html"), "utf8")).toContain("<html");
    expect(existsSync(path.join(installed, "node_modules/.bin", process.platform === "win32" ? "orch.cmd" : "orch"))).toBe(true);
  } finally {
    // temp is created above and contains only this fixture and consumer; Node
    // removes the junction itself without traversing the shared dependency tree.
    rmSync(temp, { recursive: true, force: true });
  }
});
