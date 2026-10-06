import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearSession, readSession, sessionPath, writeSession } from "../src/tasks/sessions.js";

describe("task session store", () => {
  let cwd = "";
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "orch-sessions-"));
  });
  afterEach(() => {
    rmSync(dirname(sessionPath(1, cwd)), { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns null when nothing was recorded", () => {
    expect(readSession(7, cwd)).toBeNull();
  });

  it("round-trips a session and keeps tasks independent", () => {
    writeSession(7, { agent: "claude", sessionId: "abc" }, cwd);
    writeSession(8, { agent: "codex", sessionId: "def" }, cwd);

    expect(readSession(7, cwd)).toMatchObject({ agent: "claude", sessionId: "abc" });
    expect(readSession(8, cwd)).toMatchObject({ agent: "codex", sessionId: "def" });
    expect(readSession(7, cwd)?.updatedAt).toBeTruthy();
  });

  it("overwrites with the newest session id", () => {
    writeSession(7, { agent: "claude", sessionId: "first" }, cwd);
    writeSession(7, { agent: "claude", sessionId: "second" }, cwd);
    expect(readSession(7, cwd)?.sessionId).toBe("second");
  });

  it("treats a corrupt or incomplete record as no session", () => {
    mkdirSync(dirname(sessionPath(7, cwd)), { recursive: true });
    writeFileSync(sessionPath(7, cwd), "{broken", "utf8");
    expect(readSession(7, cwd)).toBeNull();
    writeFileSync(sessionPath(7, cwd), JSON.stringify({ agent: "claude", sessionId: "" }), "utf8");
    expect(readSession(7, cwd)).toBeNull();
    writeFileSync(sessionPath(7, cwd), JSON.stringify({ sessionId: "x" }), "utf8");
    expect(readSession(7, cwd)).toBeNull();
  });

  it("clears a session", () => {
    writeSession(7, { agent: "claude", sessionId: "abc" }, cwd);
    clearSession(7, cwd);
    expect(readSession(7, cwd)).toBeNull();
    expect(() => clearSession(7, cwd)).not.toThrow();
  });
});
