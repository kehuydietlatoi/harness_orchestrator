import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnInteractive, spawnLogged } from "../src/util/spawn.js";
import { makeAdapter } from "../src/adapters/index.js";
import { DEFAULT_CONFIG } from "../src/config.js";

describe("spawnInteractive", () => {
  it("resolves with the child's exit code", async () => {
    const { code } = await spawnInteractive(process.execPath, ["-e", "process.exit(3)"]);
    expect(code).toBe(3);
  });

  it("returns 127 when the command cannot start", async () => {
    const { code } = await spawnInteractive("definitely-not-a-real-binary-xyz", []);
    expect(code).toBe(127);
  });
});

describe("spawnLogged", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), "orch-spawn-"));
    dirs.push(d);
    return d;
  };

  it("captures stdout to the log file and returns code 0", async () => {
    const log = join(tmp(), "out.log");
    const r = await spawnLogged(process.execPath, ["-e", "process.stdout.write('hello-log')"], {
      logFile: log,
    });
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(readFileSync(log, "utf8")).toContain("hello-log");
  });

  it("delivers stdin input to the child", async () => {
    const log = join(tmp(), "in.log");
    const r = await spawnLogged(
      process.execPath,
      ["-e", "process.stdin.on('data',d=>process.stdout.write('got:'+d))"],
      { logFile: log, input: "PROMPT" },
    );
    expect(r.code).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("got:PROMPT");
  });

  it("kills and reports timeout (code 124)", async () => {
    const r = await spawnLogged(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], {
      timeoutMs: 250,
    });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(124);
  });

  it("returns 127 when the command cannot start", async () => {
    const r = await spawnLogged("definitely-not-a-real-command-xyz", []);
    expect(r.code).toBe(127);
  });
});

describe("makeAdapter", () => {
  it("returns the right adapter per agent id", () => {
    expect(makeAdapter("claude", DEFAULT_CONFIG).id).toBe("claude");
    expect(makeAdapter("codex", DEFAULT_CONFIG).id).toBe("codex");
  });

  it("throws for an unknown agent", () => {
    expect(() => makeAdapter("gemini", DEFAULT_CONFIG)).toThrow(/No adapter registered/);
  });
});
