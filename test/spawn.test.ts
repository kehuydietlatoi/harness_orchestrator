import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

  // Windows launches harnesses through cmd.exe, so the direct child is a shell wrapper. A timeout that only
  // killed it left the real harness (and whatever it spawned) running: a review reported as timed out kept
  // working for 44 more minutes and its verdict was thrown away. Real processes, because only they can show it.
  it.runIf(process.platform === "win32")(
    "a timeout kills the whole process tree behind the shell wrapper, not just the wrapper",
    async () => {
      const d = tmp();
      const beat = join(d, "heartbeat.txt");
      writeFileSync(join(d, "grandchild.js"),
        `setInterval(() => require("node:fs").appendFileSync(${JSON.stringify(beat)}, "x"), 50);`);
      writeFileSync(join(d, "parent.js"),
        `require("node:child_process").spawn(process.execPath, [${JSON.stringify(join(d, "grandchild.js"))}], { stdio: "ignore" });
` +
        "setInterval(() => {}, 1000);");

      const r = await spawnLogged(process.execPath, [join(d, "parent.js")], { timeoutMs: 1200, shell: true });
      expect(r.timedOut).toBe(true);
      const alive = statSync(beat).size;
      expect(alive).toBeGreaterThan(0); // the grandchild really was running while the parent was

      await new Promise((resolve) => setTimeout(resolve, 700));
      const afterKill = statSync(beat).size;
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(statSync(beat).size).toBe(afterKill); // nothing is still writing: the whole tree is gone
    },
    20_000,
  );

  // A harness that idles on its own sub-agents is only caught by the timeout, 15+ minutes late. `abortOn`
  // stops it the moment a telltale line appears. The marker is split across two writes: a chunk boundary
  // inside a line must not hide it.
  it("aborts at once when abortOn matches a line, even one split across chunks", async () => {
    const log = join(tmp(), "abort.log");
    const script =
      "process.stdout.write('ok-line' + String.fromCharCode(10) + 'DELEG');" +
      "setTimeout(() => { process.stdout.write('ATE' + String.fromCharCode(10)); setTimeout(() => {}, 60000); }, 100);";
    const r = await spawnLogged(process.execPath, ["-e", script], {
      logFile: log,
      timeoutMs: 30_000,
      abortOn: (line) => (line === "DELEGATE" ? "delegating" : undefined),
    });
    expect(r.aborted).toBe("delegating");
    expect(r.code).toBe(125);
    expect(r.timedOut).toBe(false);
    expect(r.durationMs).toBeLessThan(10_000);
    expect(readFileSync(log, "utf8")).toContain("DELEGATE"); // what was seen is still logged
  }, 20_000);

  it("leaves a run alone when abortOn never matches", async () => {
    const r = await spawnLogged(process.execPath, ["-e", "console.log('fine')"], { abortOn: () => undefined });
    expect(r.code).toBe(0);
    expect(r.aborted).toBeUndefined();
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
