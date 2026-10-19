import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import { spawnInteractive, spawnLogged } from "../src/util/spawn.js";
import { verifyEnvironment } from "../src/tasks/verify.js";

vi.mock("../src/util/spawn.js", () => ({
  spawnLogged: vi.fn(async () => ({ code: 0, durationMs: 1, timedOut: false })),
  spawnInteractive: vi.fn(async () => ({ code: 0 })),
}));

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs(); vi.clearAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each(["claude", "codex", "opencode"].flatMap(agent => [false, true].map(configured => ({ agent, configured }))))("cleans every $agent worker mode (configured=$configured)", async ({ agent, configured }) => {
  const cwd = mkdtempSync(join(tmpdir(), "orch-env-")); dirs.push(cwd);
  const state = mkdtempSync(join(tmpdir(), "orch-state-")); dirs.push(state);
  vi.stubEnv("ORCH_HOME", state);
  const secrets = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "gh_token", "CLAUDE_CODE_MESSAGING_TOKEN",
    "PROBE_API_KEY", "ANTHROPIC_PROBE", "OPENAI_PROBE", "CODEX_PROBE", "OPENCODE_PROBE",
    "PROBE_SECRET", "PROBE_PASSWORD", "PROBE_AUTH", "PROBE_CREDENTIAL", "PROBE_CREDENTIALS"];
  for (const key of secrets) vi.stubEnv(key, "probe");
  vi.stubEnv("CODEX_HOME", cwd);
  const key = agent === "claude" ? "ANTHROPIC_API_KEY" : agent === "codex" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY";
  vi.stubEnv(key, "provider-probe");
  vi.stubEnv("MISSING_API_KEY", undefined);
  const cfg = { cmd: "fake-harness", ...(configured ? { env: [key, "MISSING_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "gh_token"] } : {}) };
  const adapter = agent === "claude" ? new ClaudeAdapter(cfg) : agent === "codex" ? new CodexAdapter(cfg) : new OpencodeAdapter(cfg);
  await adapter.runTask({ issue: 189, agent, worktree: cwd, prompt: "probe", model: { model: "zen/free" } });
  await adapter.runHeadless!({ cwd, prompt: "probe", logFile: join(cwd, "headless.log"), model: { model: "zen/free" } });
  if ("runInteractivePlan" in adapter) await adapter.runInteractivePlan!({ cwd, seed: "probe" });
  const envs = [...vi.mocked(spawnLogged).mock.calls.map(call => call[2]?.env),
    ...vi.mocked(spawnInteractive).mock.calls.map(call => call[2]?.env)];
  expect(envs).toHaveLength(agent === "claude" ? 3 : 2);
  const actual = await vi.importActual<typeof import("../src/util/spawn.js")>("../src/util/spawn.js");
  for (const [index, env] of envs.entries()) {
    expect(env).toBeDefined();
    for (const key of secrets) expect(env![key], key).toBeUndefined();
    const expected = verifyEnvironment();
    if (configured) expected[key] = "provider-probe";
    expect(env!.MISSING_API_KEY).toBeUndefined();
    if (agent === "codex") expected.CODEX_HOME = cwd;
    const comparable = { ...env };
    if (agent === "opencode") {
      expect(env!.OPENCODE_CONFIG).toBeTruthy();
      for (const key of Object.keys(comparable)) if (key.startsWith("OPENCODE_")) delete comparable[key];
    }
    expect(comparable).toEqual(expected);
    // Exercise the real spawn boundary too: filtering must survive the final merge,
    // while PWD and runtime locations remain usable by the worker's own tools.
    const file = join(cwd, "probe.json");
    const runtime = ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "TEMP", "TMP"];
    const locations = Object.fromEntries(runtime.map(key => [key, env![Object.keys(env!).find(name => process.platform === "win32" ? name.toUpperCase() === key.toUpperCase() : name === key) ?? key]]));
    const script = `require('node:fs').writeFileSync(${JSON.stringify(file)}, JSON.stringify({pwd:process.env.PWD,cwd:process.cwd(),leaked:${JSON.stringify(secrets)}.filter(k=>process.env[k]!==undefined),runtime:${JSON.stringify(runtime)}.every(k=>process.env[k]===${JSON.stringify(locations)}[k])}))`;
    const spawn = index === 2 ? actual.spawnInteractive : actual.spawnLogged;
    const result = await spawn(process.execPath, ["-e", script], { cwd, env });
    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ pwd: cwd, cwd, leaked: [], runtime: true });
  }
});
