import { resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { exec } from "../util/exec.js";
import { DEFAULT_DISPOSABLE_IGNORED } from "../config.js";

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

export type WorktreeObservation =
  | { outcome: "absent" }
  | { outcome: "usable"; worktree: Worktree }
  | { outcome: "conflict"; detail: string }
  | { outcome: "error"; detail: string };

class WorktreeReadError extends Error {}

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
    throw new WorktreeReadError(`worktree list failed: ${result.stderr.trim()}`);
  }
  const expected = pathIdentity(path);
  const match = parseWorktrees(result.stdout).find((item) => pathIdentity(item.path) === expected);
  if (!match) throw new Error(`worktree path is not registered by Git: ${path}`);
  return match;
}

/**
 * Observe whether the deterministic task path is a usable worktree without
 * creating, attaching, or removing anything.
 */
export async function observeWorktree(
  issue: number,
  title: string,
  root: string,
  opts: { cwd?: string } = {},
): Promise<WorktreeObservation> {
  const cwd = opts.cwd ?? process.cwd();
  const branch = branchName(issue, slugify(title));
  const path = worktreePath(root, issue, cwd);
  if (!existsSync(path)) return { outcome: "absent" };

  let registered: RegisteredWorktree;
  try {
    registered = await registeredWorktree(path, cwd);
  } catch (error) {
    return {
      outcome: error instanceof WorktreeReadError ? "error" : "conflict",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const expectedRef = `refs/heads/${branch}`;
  if (registered.branch !== expectedRef) {
    const actual = registered.branch?.replace(/^refs\/heads\//, "") ?? "detached HEAD";
    return {
      outcome: "conflict",
      detail: `worktree path is attached to '${actual}', expected '${branch}': ${path}`,
    };
  }
  return { outcome: "usable", worktree: { path, branch } };
}

/**
 * Create (or re-attach) an isolated worktree + branch for an issue.
 * Idempotent: if the worktree path already exists it is reused.
 */
export async function addWorktree(
  issue: number,
  title: string,
  root: string,
  opts: { baseRef: string; cwd?: string },
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
  const r = await exec("git", ["worktree", "add", "-b", branch, path, opts.baseRef], { cwd });
  if (r.code !== 0) {
    const r2 = await exec("git", ["worktree", "add", path, branch], { cwd });
    if (r2.code !== 0) {
      throw new Error(`worktree add failed: ${(r.stderr + "\n" + r2.stderr).trim()}`);
    }
  }
  return { path, branch };
}

/**
 * Pure: the entries of `git status --porcelain=v1 --untracked-files=all
 * --ignored=matching` that make a worktree unsafe to remove — every dirty or
 * untracked entry, plus ignored paths outside the `disposable` allowlist.
 * Allowlist entries are worktree-relative; a trailing `/` covers a directory and
 * its contents. Quoted (unusual-character) paths are never guessed safe.
 */
export function blockingStatusEntries(porcelain: string, disposable: readonly string[]): string[] {
  return porcelain
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .filter((line) => {
      if (!line.startsWith("!! ")) return true;
      const path = line.slice(3);
      if (path.startsWith('"')) return true;
      return !disposable.some((entry) =>
        entry.endsWith("/") ? path === entry || path.startsWith(entry) : path === entry,
      );
    });
}

export interface RemovalSafety {
  removable: boolean;
  reason?: string;
}

/**
 * The single safe-removal predicate shared by repair and every cleanup path:
 * nothing dirty, untracked, or ignored-but-not-disposable, and HEAD reachable
 * from a ref other than the checked-out branch.
 */
export async function worktreeRemovalSafety(
  path: string,
  registeredBranch: string,
  disposable: readonly string[] = DEFAULT_DISPOSABLE_IGNORED,
): Promise<RemovalSafety> {
  const status = await exec(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
    { cwd: path },
  );
  if (status.code !== 0) return { removable: false, reason: "worktree status is unreadable" };
  const blocking = blockingStatusEntries(status.stdout, disposable);
  if (blocking.length > 0) {
    const shown = blocking.slice(0, 3).map((line) => line.slice(3)).join(", ");
    const more = blocking.length > 3 ? ` (+${blocking.length - 3} more)` : "";
    return {
      removable: false,
      reason: `worktree has dirty, untracked, or non-disposable ignored files: ${shown}${more}`,
    };
  }

  const refs = await exec(
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
  if (refs.code !== 0) return { removable: false, reason: "commit reachability is unreadable" };
  const preserved = refs.stdout
    .split(/\r?\n/)
    .some((ref) => ref.length > 0 && ref !== registeredBranch);
  return preserved
    ? { removable: true }
    : { removable: false, reason: "HEAD is not preserved by another branch, remote, or tag" };
}

/**
 * Remove a worktree only when doing so cannot hide recoverable work. HEAD must
 * be attached, safe per `worktreeRemovalSafety`, and reachable elsewhere.
 */
export async function removeWorktree(
  path: string,
  opts: { cwd?: string; disposableIgnored?: readonly string[] } = {},
): Promise<boolean> {
  if (!existsSync(path)) return false;

  const cwd = opts.cwd ?? process.cwd();
  let registered: RegisteredWorktree;
  try {
    registered = await registeredWorktree(path, cwd);
  } catch {
    return false;
  }
  if (registered.branch === null) return false;

  const safety = await worktreeRemovalSafety(path, registered.branch, opts.disposableIgnored);
  if (!safety.removable) return false;

  // Without --force, git still refuses tracked modifications or untracked
  // files, so a change racing in after the check above is never discarded.
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
