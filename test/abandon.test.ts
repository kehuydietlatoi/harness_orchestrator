import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  loadConfig: vi.fn(() => ({ worktreeRoot: "../wt", agents: ["codex"], lead: "codex" })),
  resolveAgent: vi.fn(() => "codex"),
  lockRelease: vi.fn(async () => true),
  removeWorktree: vi.fn(async () => false),
  discardWorktree: vi.fn(async () => true),
  getIssue: vi.fn(async () => ({
    number: 36,
    title: "Repair",
    body: "",
    state: "OPEN",
    labels: ["status:in-progress", "agent:codex"],
    assignees: ["octocat"],
  })),
  editIssue: vi.fn(async () => undefined),
}));

vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));
vi.mock("../src/config.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../src/tasks/service.js", () => ({ resolveAgent: mocks.resolveAgent }));
vi.mock("../src/git/lock.js", () => ({ release: mocks.lockRelease }));
vi.mock("../src/git/worktree.js", () => ({
  discardWorktree: mocks.discardWorktree,
  removeWorktree: mocks.removeWorktree,
  worktreePath: () => "/wt/issue-36",
}));
vi.mock("../src/github/github.js", () => ({
  getIssue: mocks.getIssue,
  editIssue: mocks.editIssue,
}));

const { abandonCommand } = await import("../src/commands/abandon.js");

beforeEach(() => vi.clearAllMocks());

describe("abandon destructive intent", () => {
  it("preserves retained work and ownership without --discard", async () => {
    await expect(abandonCommand("36", { agent: "codex" })).rejects.toThrow(/--discard/);

    expect(mocks.removeWorktree).toHaveBeenCalledOnce();
    expect(mocks.discardWorktree).not.toHaveBeenCalled();
    expect(mocks.lockRelease).not.toHaveBeenCalled();
    expect(mocks.editIssue).not.toHaveBeenCalled();
  });

  it("force-removes work only with explicit --discard", async () => {
    await abandonCommand("36", { agent: "codex", discard: true });

    expect(mocks.discardWorktree).toHaveBeenCalledOnce();
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
    expect(mocks.lockRelease).toHaveBeenCalledOnce();
    expect(mocks.editIssue).toHaveBeenCalledOnce();
  });

  it("keeps ownership when an explicit discard fails", async () => {
    mocks.discardWorktree.mockResolvedValueOnce(false);

    await expect(
      abandonCommand("36", { agent: "codex", discard: true }),
    ).rejects.toThrow(/discard failed/);

    expect(mocks.lockRelease).not.toHaveBeenCalled();
    expect(mocks.editIssue).not.toHaveBeenCalled();
  });
});
