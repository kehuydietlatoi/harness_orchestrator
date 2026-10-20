import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type OrchConfig } from "../src/config.js";
import type { Issue } from "../src/github/github.js";
import { availabilityKey, markUnavailable, unavailableUntil } from "../src/board/availability.js";
import { readRuns } from "../src/board/telemetry.js";
import { readEvents } from "../src/tasks/events.js";
import { telemetryFact } from "../src/tasks/facts.js";
import { deriveTaskState } from "../src/tasks/lifecycle.js";
import { BUILTIN_OBSERVE_GATE, formatObservePrompt, observeAcceptance, parseObserveVerdict, pickObserveJudge, runObserveJudge } from "../src/tasks/observe-judge.js";
import type { ObserveJudgeDeps, ObserveVerdict } from "../src/tasks/observe-judge.js";

const sha = "a".repeat(40);
const acceptance = ["Observe: health is readable"];
const issue: Issue = { number: 217, title: "Observe", body: "", labels: ["effort:lead"], assignees: [], state: "OPEN" };
const fixture = (name: string) => readFileSync(new URL(`./fixtures/observe-judge/${name}.txt`, import.meta.url), "utf8");
const valid = (): ObserveVerdict => ({ gate: "observe", sha, overall: "verified",
  lines: [{ acceptance: acceptance[0], verdict: "verified", evidence: ["shots/health.png"], note: "Health is 100 and readable" }], concerns: [] });
const fenced = (v: unknown) => "```json\n" + JSON.stringify(v) + "\n```";

describe("observe judge selection", () => {
  it.each([["codex", "claude"], ["claude", "codex"]])("%s author gets %s at standard tier", (author, agent) => {
    expect(pickObserveJudge({ cfg: DEFAULT_CONFIG, issue, author, unavailable: new Set() })).toEqual({
      kind: "judge", agent, model: DEFAULT_CONFIG.adapters[agent].models?.standard,
    });
  });
  it("requires vision and availability even when self-review is enabled", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.reviewPolicy = "cross-or-self";
    cfg.adapters.claude.models!.standard!.capabilities = [];
    const none = { kind: "NoObserveJudge", reason: "no vision-capable judge of another family" };
    expect(pickObserveJudge({ cfg, issue, author: "codex", unavailable: new Set() })).toEqual(none);
    expect(pickObserveJudge({ cfg: { ...DEFAULT_CONFIG, reviewPolicy: "cross-or-self" }, issue,
      author: "codex", unavailable: new Set(["claude"]) })).toEqual(none);
  });
  it("rejects another agent with the author's resolved family", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.reviewPolicy = "cross-or-self";
    cfg.adapters.claude.models!.standard!.family = "openai";
    expect(pickObserveJudge({ cfg, issue, author: "codex", unavailable: new Set() }).kind).toBe("NoObserveJudge");
    expect(pickObserveJudge({ cfg, issue, author: null, unavailable: new Set() }).kind).toBe("NoObserveJudge");
  });
  it("uses resolved model capabilities rather than harness defaults", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.agents = ["codex", "opencode"];
    cfg.adapters.opencode = { cmd: "opencode", models: { standard: { model: "provider/vision", family: "other", capabilities: ["vision"] } } };
    expect(pickObserveJudge({ cfg, issue, author: "codex", unavailable: new Set() })).toMatchObject({ kind: "judge", agent: "opencode" });
    delete cfg.adapters.opencode.models!.standard!.capabilities;
    expect(pickObserveJudge({ cfg, issue, author: "codex", unavailable: new Set() }).kind).toBe("NoObserveJudge");
  });
});

describe("observe verdict parsing", () => {
  it.each(["verified", "not-verified", "inconclusive", "verifier-blocked"])("parses %s fixture", overall => {
    const verdict = parseObserveVerdict(fixture(overall), sha);
    expect(verdict).toMatchObject({ gate: "observe", sha, overall });
    if (overall === "not-verified") expect(verdict).toMatchObject({ lines: [{ note: "Health text is clipped on the right." }] });
  });
  it.each([
    { ...valid(), sha: "b".repeat(40) }, { ...valid(), overall: "pass" }, { ...valid(), gate: "review" },
    { ...valid(), lines: [{ ...valid().lines[0], verdict: "not-verified" }] },
    { ...valid(), lines: [{ ...valid().lines[0], evidence: "shot.png" }] },
    { ...valid(), concerns: [42] }, null,
  ])("fails closed on malformed verdict %#", value => {
    expect(parseObserveVerdict(fenced(value), sha)).toMatchObject({ kind: "judge-failed" });
  });
  it("requires a fence and uses only the last JSON block", () => {
    expect(parseObserveVerdict(JSON.stringify(valid()), sha)).toMatchObject({ kind: "judge-failed" });
    expect(parseObserveVerdict(fenced(valid()) + "\n```json\ninvalid\n```", sha)).toMatchObject({ kind: "judge-failed" });
    expect(parseObserveVerdict("No JSON block", sha)).toMatchObject({ kind: "judge-failed" });
  });
});

describe("observe judge execution", () => {
  let root: string;
  let cfg: OrchConfig;
  let params: Parameters<typeof runObserveJudge>[0];
  let deps: ObserveJudgeDeps;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "observe-judge-test-"));
    vi.stubEnv("ORCH_HOME", join(root, "orch"));
    cfg = structuredClone(DEFAULT_CONFIG);
    mkdirSync(join(root, "checkout"));
    mkdirSync(join(root, "evidence", "shots"), { recursive: true });
    writeFileSync(join(root, "evidence", "run.json"), JSON.stringify({ sha, ok: true }));
    writeFileSync(join(root, "evidence", "shots", "health.png"), "recorded screenshot");
    params = { cfg, cwd: root, issue, prNumber: 300, sha, author: "codex", acceptance: ["Unit tests pass", ...acceptance],
      checkout: { path: join(root, "checkout"), release: vi.fn() },
      results: [{ scenario: "health", status: "ok", outDir: join(root, "evidence"), durationMs: 10 }] };
    deps = { now: () => new Date(), runner: vi.fn(async () => ({ code: 0, timedOut: false, raw: "", text: fixture("verified") })) };
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  it("stages every evidence file, prompts with gate/head/Observe lines, and records once", async () => {
    mkdirSync(join(root, "gates"));
    writeFileSync(join(root, "gates", "observe.md"), "PACK GATE PROCEDURE");
    cfg.loadedPack = { path: root, roles: {} };
    expect(await runObserveJudge(params, deps)).toMatchObject({ kind: "verdict", judge: "claude", verdict: { overall: "verified" } });
    const args = vi.mocked(deps.runner).mock.calls[0];
    expect(args[1]).toContain("PACK GATE PROCEDURE");
    expect(args[1]).toContain(sha);
    expect(args[1]).toContain(acceptance[0]);
    expect(args[1]).not.toContain("Unit tests pass");
    for (const path of [".orch-observe/health", ".orch-observe/health/run.json", ".orch-observe/health/shots/health.png"]) expect(args[1]).toContain(path);
    expect(args[1]).toContain("Do NOT spawn");
    expect(args[2]).toEqual(cfg.adapters.claude.models?.standard);
    expect(args[5]).toBe(cfg.reviewTimeoutMs);
    expect(args[6]).toEqual({ readOnly: true, runCwd: params.checkout.path });
    expect(readFileSync(join(params.checkout.path, ".orch-observe/health/shots/health.png"), "utf8")).toBe("recorded screenshot");
    expect(params.checkout.release).not.toHaveBeenCalled();
    expect(readEvents(root)).toEqual([expect.objectContaining({ type: "observe.verdict", sha, signal: "observe-verified" })]);
    expect(readRuns(root)).toEqual([expect.objectContaining({ phase: "observe", outcome: "observe-verified", issue: 217, requests: 1 })]);
  });
  it.each([ ["not-verified", "observe-not-verified"], ["inconclusive", "observe-blocked"], ["verifier-blocked", "observe-blocked"] ])("records %s as %s", async (name, outcome) => {
    vi.mocked(deps.runner).mockResolvedValue({ code: 0, timedOut: false, raw: "", text: fixture(name) });
    await runObserveJudge(params, deps);
    expect(readRuns(root)).toEqual([expect.objectContaining({ outcome, phase: "observe" })]);
    expect(readEvents(root)).toHaveLength(1);
  });
  it.each(["exit", "timeout", "aborted", "invalid", "throw", "missing-line"])("records %s as judge-failed", async mode => {
    if (mode === "throw") vi.mocked(deps.runner).mockRejectedValue(new Error("spawn failed"));
    else vi.mocked(deps.runner).mockResolvedValue({ code: mode === "exit" ? 1 : 0, timedOut: mode === "timeout",
      ...(mode === "aborted" ? { aborted: "codex started delegating" } : {}), raw: "",
      text: mode === "invalid" ? "no verdict" : mode === "missing-line" ? fenced({ ...valid(), lines: [] }) : fixture("verified") });
    expect(await runObserveJudge(params, deps)).toMatchObject({ kind: "judge-failed" });
    expect(readRuns(root)).toEqual([expect.objectContaining({ outcome: "observe-failed", phase: "observe" })]);
    expect(readEvents(root)).toHaveLength(1);
  });
  it("marks a usage-limited judge unavailable", async () => {
    vi.mocked(deps.runner).mockResolvedValue({ code: 1, timedOut: false,
      raw: '{"type":"turn.failed","error":{"message":"You hit your usage limit. try again at 11:59 PM."}}', text: "" });
    expect(await runObserveJudge(params, deps)).toMatchObject({ kind: "judge-failed" });
    expect(unavailableUntil("claude", root)).not.toBeNull();
  });
  it("reads cooldowns before choosing and does not run or record when none qualifies", async () => {
    markUnavailable(availabilityKey("claude"), { resetAt: null, reason: "limit" }, root);
    cfg.reviewPolicy = "cross-or-self";
    expect(await runObserveJudge(params, deps)).toMatchObject({ kind: "NoObserveJudge" });
    expect(deps.runner).not.toHaveBeenCalled();
    expect(readRuns(root)).toEqual([]);
    expect(readEvents(root)).toEqual([]);
  });
  it("fails closed if the loaded pack has no observe gate", async () => {
    cfg.loadedPack = { path: root, roles: {} };
    expect(await runObserveJudge(params, deps)).toMatchObject({ kind: "judge-failed" });
    expect(deps.runner).not.toHaveBeenCalled();
  });
  it("uses built-in procedure without a pack and all acceptance when none is Observe", () => {
    expect(observeAcceptance(["first", "second"])).toEqual(["first", "second"]);
    const prompt = formatObservePrompt({ gate: BUILTIN_OBSERVE_GATE, sha, paths: [], acceptance: ["first", "second"] });
    expect(prompt).toContain("state dump first");
    expect(prompt).toContain('"gate": "observe"');
    expect(prompt).toContain("first\nsecond");
  });
  it.each(["observe-verified", "observe-not-verified", "observe-blocked", "observe-failed"])("%s never creates an implement failure", outcome => {
    const telemetry = telemetryFact([{ issue: 217, outcome }], 217);
    expect(telemetry).toBe("none");
    expect(deriveTaskState({ issue: "open", lock: false, worktree: false, branch: "absent", pr: "none", telemetry })).toEqual({ kind: "ready" });
  });
});
