import { describe, expect, it } from "vitest";
import { formatConflictPrompt, formatFixPrompt } from "../src/tasks/step-prompts.js";

const issue = { number: 38, title: "Add the thing", body: "spec text" };
const pr = { number: 62, headRefName: "task/38-add-the-thing" };
const base = { issue, pr, worktree: "/wt/38", reason: "review" as const, notes: "add a test", failingChecks: [], resumed: true, baseName: "main" };

describe("formatFixPrompt", () => {
  it("quotes the reviewer's notes and keeps orch in charge of pushing", () => {
    const prompt = formatFixPrompt(base);
    expect(prompt).toContain("A reviewer requested changes");
    expect(prompt).toContain("add a test");
    expect(prompt).toContain("Do NOT push");
    expect(prompt).toContain("orch submit");
    expect(prompt).toContain("/wt/38");
    expect(prompt).toContain("task/38-add-the-thing");
  });

  it("does not repeat the spec to a session that already has it", () => {
    const prompt = formatFixPrompt(base);
    expect(prompt).toContain("earlier in this conversation");
    expect(prompt).not.toContain("spec text");
  });

  it("re-briefs a cold session with the spec and where to read the diff", () => {
    const prompt = formatFixPrompt({ ...base, resumed: false });
    expect(prompt).toContain("memory is gone");
    expect(prompt).toContain("git diff main...HEAD");
    expect(prompt).toContain("spec text");
  });

  it("tells the author what to do when the reviewer left no notes", () => {
    expect(formatFixPrompt({ ...base, notes: null })).toContain("re-read the diff critically");
    expect(formatFixPrompt({ ...base, notes: "   " })).toContain("re-read the diff critically");
  });

  it("describes a CI failure and forbids weakening the check", () => {
    const prompt = formatFixPrompt({ ...base, reason: "ci", notes: null, failingChecks: ["build", "lint"] });
    expect(prompt).toContain("CI is failing");
    expect(prompt).toContain("Failing checks: build, lint");
    expect(prompt).toContain("do not weaken or skip");
  });

  it("copes with an unlisted failing check", () => {
    expect(formatFixPrompt({ ...base, reason: "ci", notes: null })).toContain("could not be listed");
  });
});

describe("formatConflictPrompt", () => {
  const prompt = formatConflictPrompt({ issue, pr, worktree: "/wt/38", baseName: "main" });

  it("asks for a merge of the fetched base, never a rebase or force-push", () => {
    expect(prompt).toContain("git merge origin/main");
    expect(prompt).toContain("not a rebase");
    expect(prompt).toContain("Never force-push");
    expect(prompt).toContain("Do NOT push");
  });

  it("requires both sides' intent to survive and the tests to pass", () => {
    expect(prompt).toContain("BOTH sides");
    expect(prompt).toContain("Run the project's tests");
    expect(prompt).toContain("spec text");
  });
});
