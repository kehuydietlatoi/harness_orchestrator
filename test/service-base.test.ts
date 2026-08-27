import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";

const mocks = vi.hoisted(() => ({
  resolveBaseBranch: vi.fn(),
  exec: vi.fn(),
  getIssue: vi.fn(),
  editIssue: vi.fn(),
  createPr: vi.fn(),
  currentLogin: vi.fn(),
}));

vi.mock("../src/git/git.js", () => ({ resolveBaseBranch: mocks.resolveBaseBranch }));
vi.mock("../src/util/exec.js", () => ({ exec: mocks.exec }));
vi.mock("../src/github/github.js", () => ({
  getIssue: mocks.getIssue,
  editIssue: mocks.editIssue,
  createPr: mocks.createPr,
  currentLogin: mocks.currentLogin,
}));

const { submit } = await import("../src/tasks/service.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveBaseBranch.mockResolvedValue({
    name: "release/v2",
    ref: "refs/remotes/origin/release/v2",
  });
  mocks.exec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  mocks.getIssue.mockResolvedValue({
    number: 37,
    title: "Repository base",
    body: "",
    state: "OPEN",
    labels: [],
    assignees: [],
  });
  mocks.createPr.mockResolvedValue("https://example.test/pull/37");
  mocks.editIssue.mockResolvedValue(undefined);
});

describe("submit base branch", () => {
  it("uses the GitHub branch name rather than its local comparison ref", async () => {
    const cfg = { ...DEFAULT_CONFIG, baseBranch: "release/v2" };

    await expect(submit(37, "codex", cfg, "/repo")).resolves.toBe(
      "https://example.test/pull/37",
    );

    expect(mocks.resolveBaseBranch).toHaveBeenCalledWith("release/v2", "/repo");
    expect(mocks.createPr).toHaveBeenCalledWith(
      expect.objectContaining({ base: "release/v2" }),
    );
  });

  it("validates the base before pushing", async () => {
    mocks.resolveBaseBranch.mockRejectedValueOnce(new Error("base branch is missing"));

    await expect(submit(37, "codex", DEFAULT_CONFIG, "/repo")).rejects.toThrow(/missing/);

    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.createPr).not.toHaveBeenCalled();
  });
});
