import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandExists, exec } from "../src/util/exec.js";

// Real subprocesses (no mocks) via the current Node binary, so these run the
// same on Linux and Windows.
const node = process.execPath;

describe("exec", () => {
  it("kills a command at its timeout and reports failure", async () => {
    const result = await exec(node, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100 });
    expect(result.code).toBe(124);
    expect(result.stderr).toContain("timed out");
  });
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

  it("reassembles multi-byte UTF-8 characters split across stream chunks", async () => {
    // Emit a large payload of 3-byte CJK characters, forcing writes that cross
    // the ~64 KiB stream highWaterMark mid-character (64 KiB is not a multiple
    // of 3, so a boundary must land inside a sequence). Decoding each chunk in
    // isolation would inject U+FFFD; the result must round-trip losslessly.
    const script =
      "const s = '\\u4e2d'.repeat(100000);" +
      "process.stdout.write(Buffer.from(s, 'utf8'));";
    const expected = "中".repeat(100000);
    const r = await exec(node, ["-e", script], { maxBuffer: 64 * 1024 * 1024 });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(expected);
    expect(r.stdout).not.toContain("�");
    expect(JSON.parse(JSON.stringify(r.stdout))).toBe(expected);
  });
});

describe("commandExists", () => {
  it("recognizes an existing absolute executable path", async () => {
    expect(await commandExists(node)).toBe(true);
  });

  it("rejects a missing absolute executable path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-command-"));
    try {
      expect(await commandExists(join(dir, "missing.exe"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an absolute directory path", async () => {
    expect(await commandExists(tmpdir())).toBe(false);
  });

  it.skipIf(process.platform === "win32")("rejects a file without execute permission on POSIX", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-command-"));
    try {
      const file = join(dir, "not-executable");
      await writeFile(file, "", { mode: 0o600 });
      expect(await commandExists(file)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is true for a binary on PATH and false otherwise", async () => {
    // `node` is on PATH in CI (actions/setup-node) and local dev environments.
    expect(await commandExists("node")).toBe(true);
    expect(await commandExists("definitely-not-a-real-binary-xyz")).toBe(false);
  });
});
