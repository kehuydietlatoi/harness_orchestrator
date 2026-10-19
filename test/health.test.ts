import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endpointHealthy, healthPath, HEALTH_TTL_MS } from "../src/board/health.js";
import { markUnavailable, unavailableUntil } from "../src/board/availability.js";
import { DEFAULT_CONFIG, type OrchConfig } from "../src/config.js";
import { readRuns } from "../src/board/telemetry.js";
import { readEvents } from "../src/tasks/events.js";

const mocks = vi.hoisted(() => ({ ping: vi.fn(), claim: vi.fn(), next: vi.fn(), edit: vi.fn(), list: vi.fn() }));
vi.mock("../src/adapters/opencode.js", () => ({ OpencodeAdapter: class { pingEndpoint = mocks.ping; } }));
vi.mock("../src/tasks/service.js", () => ({ claimSpecific: mocks.claim, claimNext: mocks.next }));
vi.mock("../src/github/github.js", () => ({ listIssues: mocks.list, editIssue: mocks.edit, ensureLabels: vi.fn() }));
import { dispatchSpecific, processNext } from "../src/tasks/runner.js";

describe("pre-claim endpoint health", () => {
  let cwd: string;
  let time: number;
  const now = () => new Date(time);
  beforeEach(() => {
    vi.clearAllMocks();
    cwd = mkdtempSync(join(tmpdir(), "orch-health-"));
    time = Date.parse("2026-10-18T12:00:00Z");
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("persists a result across dispatches until exactly ten minutes", async () => {
    const ping = vi.fn(async () => true);
    const check = () => endpointHealthy("opencode", "zen/free", cwd, undefined, { now, ping });
    expect(await check()).toBe(true);
    time += HEALTH_TTL_MS - 1;
    expect(await check()).toBe(true);
    expect(ping).toHaveBeenCalledTimes(1);
    time++;
    expect(await check()).toBe(true);
    expect(ping).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(healthPath(cwd), "utf8"))["zen/free"]).toEqual({ ts: time, ok: true });
  });

  it("coalesces concurrent pings and isolates slugs", async () => {
    const ping = vi.fn(async () => true);
    await Promise.all([1, 2].map(() => endpointHealthy("opencode", "zen/free", cwd, undefined, { now, ping })));
    expect(ping).toHaveBeenCalledTimes(1);
    await endpointHealthy("opencode", "zen/cheap", cwd, undefined, { now, ping });
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it.each(["claude", "codex"])("never pings %s", async agent => {
    const ping = vi.fn();
    expect(await endpointHealthy(agent, "some/model", cwd, undefined, { now, ping })).toBe(true);
    expect(ping).not.toHaveBeenCalled();
  });

  it("treats corrupt cache as a miss and a thrown ping as a cooldown", async () => {
    await endpointHealthy("opencode", "zen/other", cwd, undefined, { now, ping: async () => true });
    writeFileSync(healthPath(cwd), "broken");
    const ping = vi.fn(async () => { throw new Error("spawn failed"); });
    expect(await endpointHealthy("opencode", "zen/free", cwd, undefined, { now, ping })).toBe(false);
    expect(await endpointHealthy("opencode", "zen/free", cwd, undefined, { now, ping })).toBe(false);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(unavailableUntil("opencode:zen/free", cwd, now())).not.toBeNull();
    expect(unavailableUntil("opencode:zen/free", cwd, now())?.getTime()).toBe(time + 10 * 60_000);
    expect(unavailableUntil("opencode:zen/other", cwd, now())).toBeNull();
    time += 10 * 60_000;
    expect(unavailableUntil("opencode:zen/free", cwd, now())).toBeNull();
    expect(await endpointHealthy("opencode", "zen/free", cwd, undefined, { now, ping: async () => true })).toBe(true);
  });

  it.each(["targeted", "next", "failed-relabel"])("cascades a dead endpoint before a %s claim", async mode => {
    const issue = { number: 123, title: "health", body: "", state: "OPEN", labels: ["agent:opencode", "status:todo", "effort:free"], assignees: [] };
    const from = { agent: "opencode", tier: "free" as const, model: "zen/free", family: "zen" };
    const to = { ...from, model: "zen/next" };
    const cooled = { ...from, model: "zen/cooled" };
    const cfg: OrchConfig = { ...DEFAULT_CONFIG, agents: ["opencode"], defaultEffort: "free",
      adapters: { opencode: { cmd: "opencode", models: { free: from } } },
      tierMembers: { free: [from, cooled, to], cheap: [], standard: [], lead: [] } };
    markUnavailable("opencode:zen/cooled", { resetAt: null, reason: "known outage" }, cwd);
    mocks.list.mockResolvedValue([issue]);
    mocks.ping.mockResolvedValue(false);
    mocks.next.mockImplementation(async (_a, _c, _d, opts) => {
      expect(await opts.canClaim(issue)).toBe(false);
      return null;
    });
    if (mode === "failed-relabel") {
      mocks.edit.mockRejectedValueOnce(new Error("write failed"));
      await expect(dispatchSpecific(123, cfg, cwd)).rejects.toThrow("write failed");
      expect(readEvents(cwd)).toEqual([]);
      expect(readRuns(cwd)).toEqual([]);
      return;
    }
    if (mode === "targeted") await dispatchSpecific(123, cfg, cwd);
    else {
      const onCascade = vi.fn();
      await processNext("opencode", cfg, cwd, { onCascade });
      expect(onCascade).toHaveBeenCalledOnce();
      expect(onCascade).toHaveBeenCalledWith("opencode");
    }
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.edit).toHaveBeenCalledWith(123, { cwd,
      addLabels: ["agent:opencode", "effort:free", "model:zen/next"], removeLabels: [] });
    expect(readEvents(cwd)).toMatchObject([{ type: "cascade.hop", issue: 123, cascadeFrom: from, cascadeTo: to }]);
    expect(readRuns(cwd)).toEqual([]);
  });

  it("skips failed pings before targeted or next claims without touching todo labels or recording failure", async () => {
    const issue = { number: 123, title: "health", body: "", state: "OPEN", labels: ["agent:opencode", "status:todo", "effort:free"], assignees: [] };
    const cfg: OrchConfig = { ...DEFAULT_CONFIG, agents: ["opencode"], defaultEffort: "free",
      adapters: { opencode: { cmd: "opencode", models: { free: { model: "zen/free" } } } } };
    mocks.list.mockResolvedValue([issue]);
    mocks.ping.mockResolvedValue(false);
    expect(await dispatchSpecific(123, cfg, cwd)).toMatchObject({ outcome: "requeued" });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(unavailableUntil("opencode:zen/free", cwd)).not.toBeNull();
    mocks.next.mockImplementation(async (_a, _c, _d, opts) => {
      expect(await opts.canClaim(issue)).toBe(false);
      return null;
    });
    const onCascade = vi.fn();
    expect(await processNext("opencode", cfg, cwd, { onCascade })).toBeNull();
    expect(onCascade).not.toHaveBeenCalled();
    expect(mocks.ping).toHaveBeenCalledTimes(1);
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(issue.labels).toEqual(["agent:opencode", "status:todo", "effort:free"]);
    expect(readRuns(cwd)).toEqual([]);
  });
});
