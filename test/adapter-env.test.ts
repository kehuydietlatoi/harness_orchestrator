import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeAdapter } from "../src/adapters/index.js";
import { DEFAULT_CONFIG } from "../src/config.js";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));

const dirs: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("harness spawn environments", () => {
  it.each(["claude", "codex", "opencode"])("aligns %s task and headless PWD with the spawn cwd", async agent => {
    const root = mkdtempSync(join(tmpdir(), "orch-adapter-env-"));
    dirs.push(root);
    const worktree = join(root, "task");
    mkdirSync(worktree);
    vi.stubEnv("ORCH_HOME", join(root, "state"));
    vi.stubEnv("PWD", join(root, "operator-checkout"));
    const inheritedPwd = process.env.PWD;
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      });
      queueMicrotask(() => child.emit("close", 0));
      return child as ReturnType<typeof spawn>;
    });
    const adapter = makeAdapter(agent, {
      ...DEFAULT_CONFIG,
      adapters: { ...DEFAULT_CONFIG.adapters, [agent]: { cmd: `${agent}.exe` } },
    });
    const logFile = join(worktree, "run.jsonl");
    const model = { model: "provider/model" };
    await adapter.runTask({ issue: 188, agent, worktree, prompt: "test", model, logFile });
    await adapter.runHeadless!({ cwd: worktree, prompt: "test", model, logFile, readOnly: true });
    if (adapter.runInteractivePlan) {
      await adapter.runInteractivePlan({ cwd: worktree, seed: "test", model });
    }
    expect(spawn).toHaveBeenCalledTimes(adapter.runInteractivePlan ? 3 : 2);
    for (const call of vi.mocked(spawn).mock.calls) {
      expect(call[2]).toMatchObject({ cwd: worktree, env: { PWD: worktree } });
    }
    expect(process.env.PWD).toBe(inheritedPwd);
  });
});
