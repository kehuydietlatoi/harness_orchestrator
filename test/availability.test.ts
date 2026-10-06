import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  availabilityPath,
  DEFAULT_COOLDOWN_MS,
  markUnavailable,
  noteUsageLimitFromLog,
  unavailableAgents,
  unavailableUntil,
} from "../src/board/availability.js";

const now = new Date("2026-10-06T12:00:00Z");
const minutes = (n: number) => new Date(now.getTime() + n * 60_000).toISOString();

describe("harness availability store", () => {
  let cwd = "";
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "orch-avail-"));
  });
  afterEach(() => {
    rmSync(dirname(availabilityPath(cwd)), { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("is available when nothing is recorded", () => {
    expect(unavailableUntil("codex", cwd, now)).toBeNull();
    expect(unavailableAgents(["claude", "codex"], cwd, now).size).toBe(0);
  });

  it("marks an agent unavailable until its reset and then lets it back in", () => {
    markUnavailable("codex", { resetAt: minutes(90), reason: "usage limit" }, cwd, now);

    expect(unavailableUntil("codex", cwd, now)?.toISOString()).toBe(minutes(90));
    expect(unavailableUntil("claude", cwd, now)).toBeNull();
    expect([...unavailableAgents(["claude", "codex"], cwd, now)]).toEqual(["codex"]);
    expect(unavailableUntil("codex", cwd, new Date(minutes(91)))).toBeNull();
  });

  it("falls back to the default cooldown when no reset time is known", () => {
    const until = markUnavailable("codex", { resetAt: null, reason: "limit" }, cwd, now);
    expect(until.getTime()).toBe(now.getTime() + DEFAULT_COOLDOWN_MS);
  });

  it("clamps a reset that is implausibly far away or already past", () => {
    const far = markUnavailable("a", { resetAt: minutes(60 * 24 * 5), reason: "x" }, cwd, now);
    expect(far.getTime() - now.getTime()).toBe(12 * 60 * 60 * 1000);
    const past = markUnavailable("b", { resetAt: minutes(-30), reason: "x" }, cwd, now);
    expect(past.getTime() - now.getTime()).toBe(60_000);
  });

  it("keeps other agents' entries when updating one", () => {
    markUnavailable("codex", { resetAt: minutes(30), reason: "x" }, cwd, now);
    markUnavailable("claude", { resetAt: minutes(60), reason: "y" }, cwd, now);
    expect(unavailableAgents(["claude", "codex"], cwd, now).size).toBe(2);
  });

  it("treats a corrupt store as nothing known rather than throwing", () => {
    mkdirSync(dirname(availabilityPath(cwd)), { recursive: true });
    writeFileSync(availabilityPath(cwd), "{not json", "utf8");
    expect(unavailableUntil("codex", cwd, now)).toBeNull();
    writeFileSync(availabilityPath(cwd), JSON.stringify({ codex: { until: "garbage" } }), "utf8");
    expect(unavailableUntil("codex", cwd, now)).toBeNull();
  });

  it("notes a usage limit from a log and ignores unrelated failures", () => {
    const log = '{"type":"turn.failed","error":{"message":"You hit your usage limit. try again at 11:59 PM."}}';
    expect(noteUsageLimitFromLog("codex", "segfault", cwd, now)).toBeNull();
    expect(unavailableUntil("codex", cwd, now)).toBeNull();

    expect(noteUsageLimitFromLog("codex", log, cwd, now)).not.toBeNull();
    expect(unavailableUntil("codex", cwd, now)).not.toBeNull();
  });
});
