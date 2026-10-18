import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { AdapterConfig, ModelSpec } from "../config.js";
import { projectStateDir } from "../board/telemetry.js";
import { commandExists, exec } from "../util/exec.js";
import { logSize, readLogSince } from "../util/log-file.js";
import { spawnLogged } from "../util/spawn.js";
import { buildOpencodeArgv, reduceOpencode } from "./opencode-events.js";
import type { HarnessAdapter, HeadlessContext, HeadlessResult, RunContext, RunResult } from "./types.js";

/** Ordered rules: the last matching bash pattern wins in OpenCode. */
export function opencodePermissions(readOnly = false) {
  return {
    edit: readOnly ? "deny" : "allow",
    bash: {
      "*": "deny",
      "git status*": "allow",
      "git diff*": "allow",
      "git log*": "allow",
      "rg *": "allow",
      "ls*": "allow",
      "git push*": "deny",
    },
    webfetch: "deny",
  };
}

/** OpenCode must be a native executable, never a Windows shell shim. */
export class OpencodeAdapter implements HarnessAdapter {
  readonly id = "opencode";
  constructor(
    private readonly cfg?: AdapterConfig,
    private readonly spawn: typeof spawnLogged = spawnLogged,
  ) {}

  private async command(): Promise<string> {
    if (this.cfg?.cmd) return this.cfg.cmd;
    const name = process.platform === "win32" ? "opencode.exe" : "opencode";
    const found = process.platform === "win32"
      ? await exec("where", [name])
      : await exec("sh", ["-c", 'command -v "$1"', "sh", name]);
    if (found.code !== 0 || !found.stdout.trim()) throw new Error(`Cannot resolve ${name}`);
    return found.stdout.trim().split(/\r?\n/)[0];
  }

  async healthCheck(): Promise<boolean> {
    try {
      const cmd = await this.command();
      return await commandExists(cmd) && (await exec(cmd, ["--version"])).code === 0;
    } catch { return false; }
  }

  /** Probe the model, rather than just the local CLI, before claiming work. */
  async pingEndpoint(slug: string, cwd: string): Promise<boolean> {
    const { result, reduced } = await this.run({
      cwd, prompt: "Reply OK", model: { model: slug }, timeoutMs: 60_000, readOnly: true,
    });
    return result.code === 0 && reduced.outcome === "completed" && reduced.resultText.trim() === "OK";
  }

  private async run(ctx: {
    cwd: string; prompt: string; model?: ModelSpec; logFile?: string;
    timeoutMs?: number; resumeSession?: string; readOnly?: boolean;
  }) {
    if (!ctx.model?.model) throw new Error("OpenCode requires an explicit provider/model");
    const cmd = await this.command();
    const state = projectStateDir(ctx.cwd);
    mkdirSync(state, { recursive: true });
    // ORCH_HOME may be overridden; fail closed even when it resolves through a symlink into the checkout.
    const inside = relative(realpathSync(ctx.cwd), realpathSync(state));
    if (inside === "" || (!isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${sep}`))) {
      throw new Error("OpenCode config state directory must be outside the worktree");
    }
    const runDir = mkdtempSync(join(state, "opencode-"));
    try {
      const config = join(runDir, "config.json");
      writeFileSync(config, JSON.stringify({ permission: opencodePermissions(ctx.readOnly) }), { mode: 0o600 });
      const logFile = ctx.logFile ?? join(runDir, "output.jsonl");
      mkdirSync(dirname(logFile), { recursive: true });
      const mark = logSize(logFile);
      const result = await this.spawn(cmd, buildOpencodeArgv({
        model: ctx.model.model, variant: ctx.model.effort, resumeSession: ctx.resumeSession,
      }), {
        cwd: ctx.cwd, input: ctx.prompt, logFile, timeoutMs: ctx.timeoutMs,
        shell: false, env: { ...process.env, OPENCODE_CONFIG: config },
      });
      const raw = readLogSince(logFile, mark);
      // spawnLogged combines both streams; the reducer ignores non-JSON stderr lines.
      const reduced = reduceOpencode({ lines: raw, stderr: raw, exitCode: result.code, timedOut: result.timedOut });
      return { result, reduced, raw };
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  }

  async runTask(ctx: RunContext): Promise<RunResult> {
    const { result, reduced } = await this.run({ ...ctx, cwd: ctx.worktree });
    return {
      ...result, ok: reduced.outcome === "completed", logFile: ctx.logFile,
      sessionId: reduced.sessionId ?? ctx.resumeSession,
    };
  }

  async runHeadless(ctx: HeadlessContext): Promise<HeadlessResult> {
    const { result, reduced, raw } = await this.run(ctx);
    return {
      ...result, code: reduced.outcome === "completed" ? result.code : result.code || 1,
      text: reduced.resultText, raw,
    };
  }
}
