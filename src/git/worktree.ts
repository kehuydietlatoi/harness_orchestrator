import { resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { exec } from "../util/exec.js";

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

interface RegisteredWorktree {
  path: string;
  branch: string | null;
}

function pathIdentity(path: string): string {
  const absolute = resolve(path);
  const canonical = existsSync(absolute) ? realpathSync.native(absolute) : absolute;
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function parseWorktrees(output: string): RegisteredWorktree[] {
  const worktrees: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null };
      worktrees.push(current);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    }
  }
  return worktrees;
}

async function registeredWorktree(path: string, cwd: string): Promise<RegisteredWorktree> {
  const result = await exec("git", ["worktree", "list", "--porcelain"], { cwd });
  if (result.code !== 0) {
    throw new Error(`worktree list failed: ${result.stderr.trim()}`);
  }
  const expected = pathIdentity(path);
  const match = parseWorktrees(result.stdout).find((item) => pathIdentity(item.path) === expected);
  if (!match) throw new Error(`worktree path is not registered by Git: ${path}`);
  return match;
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

  if (existsSync(path)) {
    const registered = await registeredWorktree(path, cwd);
    const expectedRef = `refs/heads/${branch}`;
    if (registered.branch !== expectedRef) {
      const actual = registered.branch?.replace(/^refs\/heads\//, "") ?? "detached HEAD";
      throw new Error(
        `worktree path is attached to '${actual}', expected '${branch}': ${path}`,
      );
    }
    return { path, branch };
  }

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

/**
 * Remove a worktree only when doing so cannot hide recoverable work. HEAD must
 * be attached, clean, and reachable from a ref other than the checked-out branch.
 */
export async function removeWorktree(path: string, opts: { cwd?: string } = {}): Promise<boolean> {
  if (!existsSync(path)) return false;

  const cwd = opts.cwd ?? process.cwd();
  let registered: RegisteredWorktree;
  try {
    registered = await registeredWorktree(path, cwd);
  } catch {
    return false;
  }
  if (registered.branch === null) return false;

  const status = await exec(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
    { cwd: path },
  );
  if (status.code !== 0 || status.stdout.length > 0) return false;

  const containingRefs = await exec(
    "git",
    [
      "for-each-ref",
      "--contains=HEAD",
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ],
    { cwd: path },
  );
  if (containingRefs.code !== 0) return false;
  const preservedElsewhere = containingRefs.stdout
    .split(/\r?\n/)
    .some((ref) => ref.length > 0 && ref !== registered.branch);
  if (!preservedElsewhere) return false;

  const r = await exec("git", ["worktree", "remove", path], { cwd });
  return r.code === 0;
}

/** Explicitly discard a registered worktree, including any recoverable local files. */
export async function discardWorktree(
  path: string,
  opts: { cwd?: string } = {},
): Promise<boolean> {
  const r = await exec("git", ["worktree", "remove", "--force", path], { cwd: opts.cwd });
  return r.code === 0;
}
