import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpencodeAdapter, opencodePermissions } from "../src/adapters/opencode.js";
import { buildOpencodeArgv, reduceOpencode } from "../src/adapters/opencode-events.js";
import { makeAdapter } from "../src/adapters/index.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { parseUsage } from "../src/board/telemetry.js";
import { commandExists, exec } from "../src/util/exec.js";
import type { spawnLogged } from "../src/util/spawn.js";

vi.mock("../src/util/exec.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/util/exec.js")>(),
  commandExists: vi.fn(), exec: vi.fn(),
}));

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "orch-opencode-")); dirs.push(dir); return dir; };
const fixture = (name: string) => readFileSync(new URL(`./fixtures/opencode-1.19.3/${name}.jsonl`, import.meta.url), "utf8");
const model = { model: "opencode/deepseek-v4.1-flash-free", effort: "high" };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("OpenCode adapter", () => {
  it("is registered without interactive planning", () => {
    const adapter = makeAdapter("opencode", DEFAULT_CONFIG);
    expect(adapter).toBeInstanceOf(OpencodeAdapter);
    expect(adapter.runInteractivePlan).toBeUndefined();
  });

  it.each([false, true])("uses deterministic permissions (readOnly=%s)", readOnly => {
    const permission = opencodePermissions(readOnly);
    expect(JSON.stringify(permission)).not.toContain("ask");
    expect(permission.edit).toBe(readOnly ? "deny" : "allow");
    expect(permission.webfetch).toBe("deny");
    expect(permission.bash).toEqual({
      "*": "deny", "git status*": "allow", "git diff*": "allow", "git log*": "allow",
      "rg *": "allow", "ls*": "allow", "git push*": "deny",
    });
  });

  it("sends stdin and resume argv directly, with a unique external config per run", async () => {
    const worktree = temp();
    const configs: string[] = [];
    const spawn: typeof spawnLogged = vi.fn(async (cmd, args, opts) => {
      expect(cmd).toBe("C:/tools/opencode.exe");
      expect(args).toEqual(buildOpencodeArgv({ model: model.model, variant: "high", resumeSession: "ses_previous" }));
      expect(opts).toMatchObject({ cwd: worktree, input: "fix toy\nwith `quotes`", shell: false });
      const path = opts!.env!.OPENCODE_CONFIG!;
      const rel = relative(worktree, path);
      expect(isAbsolute(path)).toBe(true);
      expect(rel.startsWith("..") || isAbsolute(rel)).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ permission: opencodePermissions() });
      configs.push(path);
      appendFileSync(opts!.logFile!, fixture("success-edit"));
      return { code: 0, durationMs: 12, timedOut: false };
    });
    const adapter = new OpencodeAdapter({ cmd: "C:/tools/opencode.exe" }, spawn);
    for (let i = 0; i < 2; i++) {
      const result = await adapter.runTask({ issue: 119, agent: "opencode", worktree, prompt: "fix toy\nwith `quotes`", model, resumeSession: "ses_previous" });
      expect(result).toMatchObject({ ok: true, code: 0, durationMs: 12, sessionId: reduceOpencode({ lines: fixture("success-edit"), stderr: "", exitCode: 0, timedOut: false }).sessionId });
    }
    expect(configs[0]).not.toBe(configs[1]);
    expect(configs.every(path => !existsSync(path))).toBe(true);
  });

  it("reads only this run's log and rejects incomplete exit-zero output", async () => {
    const worktree = temp();
    const logFile = join(worktree, "run.jsonl");
    writeFileSync(logFile, fixture("success-edit"));
    const spawn: typeof spawnLogged = async (_cmd, _args, opts) => {
      appendFileSync(opts!.logFile!, fixture("ask-auto-rejected-early-stop") + "\nauto-rejecting\n");
      return { code: 0, durationMs: 1, timedOut: false };
    };
    const result = await new OpencodeAdapter({ cmd: "opencode.exe" }, spawn).runTask({ issue: 119, agent: "opencode", worktree, prompt: "fix", model, logFile });
    expect(result.ok).toBe(false);
  });

  it("denies edits in headless review and fails closed on incomplete output", async () => {
    const cwd = temp();
    const spawn: typeof spawnLogged = async (_cmd, args, opts) => {
      expect(args).toEqual(buildOpencodeArgv({ model: model.model, variant: model.effort }));
      expect(JSON.parse(readFileSync(opts!.env!.OPENCODE_CONFIG!, "utf8")).permission.edit).toBe("deny");
      appendFileSync(opts!.logFile!, '{"type":"text","sessionID":"ses_x","part":{"text":"partial"}}\n');
      return { code: 0, durationMs: 1, timedOut: false };
    };
    const result = await new OpencodeAdapter({ cmd: "opencode.exe" }, spawn).runHeadless({ cwd, logFile: join(cwd, "logs", "review.jsonl"), prompt: "review", model, readOnly: true });
    expect(result).toMatchObject({ code: 1, text: "partial", timedOut: false });
  });

  it("cleans up config after a spawn exception", async () => {
    let config = "";
    const spawn: typeof spawnLogged = async (_cmd, _args, opts) => {
      config = opts!.env!.OPENCODE_CONFIG!;
      throw new Error("spawn failure");
    };
    await expect(new OpencodeAdapter({ cmd: "opencode.exe" }, spawn).runTask({ issue: 119, agent: "opencode", worktree: temp(), prompt: "fix", model })).rejects.toThrow("spawn failure");
    expect(existsSync(config)).toBe(false);
  });

  it("rejects state inside the worktree before spawning", async () => {
    const worktree = temp();
    vi.stubEnv("ORCH_HOME", join(worktree, "state"));
    const spawn = vi.fn<typeof spawnLogged>();
    await expect(new OpencodeAdapter({ cmd: "opencode.exe" }, spawn).runTask({ issue: 119, agent: "opencode", worktree, prompt: "fix", model })).rejects.toThrow("outside the worktree");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not report a timed-out run as completed", async () => {
    const spawn: typeof spawnLogged = async (_cmd, _args, opts) => {
      appendFileSync(opts!.logFile!, fixture("success-edit"));
      return { code: 124, durationMs: 5, timedOut: true };
    };
    const result = await new OpencodeAdapter({ cmd: "opencode.exe" }, spawn).runTask({ issue: 119, agent: "opencode", worktree: temp(), prompt: "fix", model });
    expect(result).toMatchObject({ ok: false, code: 124, timedOut: true });
  });

  it("requires an installed executable and a successful version command", async () => {
    const adapter = new OpencodeAdapter({ cmd: "custom.exe" });
    vi.mocked(commandExists).mockResolvedValue(false);
    expect(await adapter.healthCheck()).toBe(false);
    vi.mocked(commandExists).mockResolvedValue(true);
    vi.mocked(exec).mockResolvedValue({ code: 1, stdout: "", stderr: "broken" });
    expect(await adapter.healthCheck()).toBe(false);
    vi.mocked(exec).mockResolvedValue({ code: 0, stdout: "1.19.3", stderr: "" });
    expect(await adapter.healthCheck()).toBe(true);
    expect(exec).toHaveBeenLastCalledWith("custom.exe", ["--version"]);
  });

  it("uses the reducer's cumulative usage", () => {
    const raw = fixture("success-edit");
    const usage = reduceOpencode({ lines: raw, stderr: "", exitCode: 0, timedOut: false }).usage;
    expect(parseUsage(raw, "opencode")).toEqual({
      tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, tokensTotal: usage.tokensIn + usage.tokensOut,
      cachedInputTokens: usage.cachedInputTokens, costUsd: usage.costUsd,
    });
  });
});

it.skipIf(process.env.ORCH_OPENCODE_LIVE !== "1")("live OpenCode fixes a toy file", async () => {
  vi.mocked(exec).mockImplementation((await vi.importActual<typeof import("../src/util/exec.js")>("../src/util/exec.js")).exec);
  const worktree = temp();
  writeFileSync(join(worktree, "toy.txt"), "broken\n");
  const result = await new OpencodeAdapter().runTask({
    issue: 119, agent: "opencode", worktree,
    prompt: "Use the edit tool to replace broken with fixed in toy.txt. Do not run shell commands. Then stop.",
    model: { model: "opencode/deepseek-v4.1-flash-free" }, timeoutMs: 180_000,
  });
  expect(result.ok).toBe(true);
  expect(result.sessionId).toBeTruthy();
  expect(readFileSync(join(worktree, "toy.txt"), "utf8")).toBe("fixed\n");
}, 200_000);
