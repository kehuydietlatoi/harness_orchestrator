import { describe, expect, it } from "vitest";
import { commandExists, exec } from "../src/util/exec.js";

// Real subprocesses (no mocks) via the current Node binary, so these run the
// same on Linux and Windows.
const node = process.execPath;

describe("exec", () => {
  it("captures stdout and a zero exit code", async () => {
    const r = await exec(node, ["-e", "process.stdout.write('hello')"]);
    expect(r).toEqual({ code: 0, stdout: "hello", stderr: "" });
  });

  it("surfaces a non-zero exit code without throwing", async () => {
    const r = await exec(node, ["-e", "process.exit(3)"]);
    expect(r.code).toBe(3);
  });

  it("returns code 127 when the command cannot be spawned", async () => {
    const r = await exec("definitely-not-a-real-binary-xyz");
    expect(r.code).toBe(127);
  });

  it("pipes input to stdin", async () => {
    const r = await exec(node, ["-e", "process.stdin.pipe(process.stdout)"], { input: "ping" });
    expect(r.stdout).toBe("ping");
    expect(r.code).toBe(0);
  });

  it("fails loudly instead of truncating silently when output exceeds maxBuffer", async () => {
    const r = await exec(node, ["-e", "process.stdout.write('x'.repeat(10000))"], { maxBuffer: 100 });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("maxBuffer");
    expect(r.stdout.length).toBeLessThanOrEqual(100);
  });

  it("does not overflow for output at/under the cap", async () => {
    const r = await exec(node, ["-e", "process.stdout.write('y'.repeat(90))"], { maxBuffer: 100 });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("y".repeat(90));
    expect(r.stderr).toBe("");
  });
});

describe("commandExists", () => {
  it("is true for a binary on PATH and false otherwise", async () => {
    // `node` is on PATH in CI (actions/setup-node) and local dev environments.
    expect(await commandExists("node")).toBe(true);
    expect(await commandExists("definitely-not-a-real-binary-xyz")).toBe(false);
  });
});
