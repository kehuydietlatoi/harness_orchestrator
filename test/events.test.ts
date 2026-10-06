import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent, eventsPath, fixRoundsFor, readEvents, type OrchEvent } from "../src/tasks/events.js";

const ev = (over: Partial<OrchEvent> & { type: string }): OrchEvent => ({ ts: "2026-10-06T12:00:00Z", issue: 7, ...over });

describe("event log", () => {
  let cwd = "";
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "orch-events-"));
  });
  afterEach(() => {
    rmSync(dirname(eventsPath(cwd)), { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("appends and reads events in order with a timestamp", () => {
    appendEvent({ type: "task.started", issue: 7, agent: "claude" }, cwd, new Date("2026-10-06T10:00:00Z"));
    appendEvent({ type: "step.finished", issue: 7, step: "review", signal: "review.approved" }, cwd);

    const events = readEvents(cwd);
    expect(events.map((e) => e.type)).toEqual(["task.started", "step.finished"]);
    expect(events[0].ts).toBe("2026-10-06T10:00:00.000Z");
    expect(events[1]).toMatchObject({ step: "review", signal: "review.approved" });
  });

  it("returns nothing when there is no log", () => {
    expect(readEvents(cwd)).toEqual([]);
  });

  it("skips torn and malformed lines instead of failing", () => {
    appendEvent({ type: "task.started", issue: 7 }, cwd);
    appendFileSync(eventsPath(cwd), '{"type":"step.fin\nnot json\n{"ts":"x","issue":"seven","type":"t"}\n', "utf8");
    appendEvent({ type: "task.merged", issue: 7 }, cwd);
    expect(readEvents(cwd).map((e) => e.type)).toEqual(["task.started", "task.merged"]);
  });
});

describe("fixRoundsFor", () => {
  const pushed = (issue: number, signal = "fix.pushed") => ev({ type: "step.finished", issue, step: "fix", signal });

  it("counts pushed fixes and conflict resolutions for the issue", () => {
    expect(fixRoundsFor([pushed(7), pushed(7, "conflict.resolved"), pushed(8)], 7)).toBe(2);
  });

  it("does not count failed, unavailable, or review steps", () => {
    const events = [
      ev({ type: "step.finished", step: "fix", signal: "step.failed" }),
      ev({ type: "step.finished", step: "fix", signal: "agent.unavailable" }),
      ev({ type: "step.finished", step: "review", signal: "review.changes_requested" }),
      ev({ type: "step.started", step: "fix" }),
    ];
    expect(fixRoundsFor(events, 7)).toBe(0);
  });

  it("restarts the count when the task is claimed again", () => {
    const events = [pushed(7), pushed(7), ev({ type: "task.started" }), pushed(7)];
    expect(fixRoundsFor(events, 7)).toBe(1);
  });

  it("is not reset by another task starting", () => {
    expect(fixRoundsFor([pushed(7), ev({ type: "task.started", issue: 8 })], 7)).toBe(1);
  });
});
