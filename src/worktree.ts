import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { exec } from "./util/exec.js";

export interface Worktree {
  path: string;
  branch: string;
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}

export function branchName(issue: number, slug: string): string {
  return `task/${issue}-${slug}`;
}

export function worktreePath(root: string, issue: number, repoCwd: string): string {
  return resolve(repoCwd, root, `issue-${issue}`);
}

/**
 * Create (or re-attach) an isolated worktree + branch for an issue.
 * Idempotent: if the worktree path already exists it is reused.
 */
export async function addWorktree(
  issue: number,
  title: string,
  root: string,
  opts: { cwd?: string } = {},
): Promise<Worktree> {
  const cwd = opts.cwd ?? process.cwd();
  const branch = branchName(issue, slugify(title));
  const path = worktreePath(root, issue, cwd);

  if (existsSync(path)) return { path, branch };

  // Try to create a fresh branch; fall back to attaching an existing branch.
  const r = await exec("git", ["worktree", "add", "-b", branch, path], { cwd });
  if (r.code !== 0) {
    const r2 = await exec("git", ["worktree", "add", path, branch], { cwd });
    if (r2.code !== 0) {
      throw new Error(`worktree add failed: ${(r.stderr + "\n" + r2.stderr).trim()}`);
    }
  }
  return { path, branch };
}

export async function removeWorktree(path: string, opts: { cwd?: string } = {}): Promise<boolean> {
  const r = await exec("git", ["worktree", "remove", "--force", path], { cwd: opts.cwd });
  return r.code === 0;
}
