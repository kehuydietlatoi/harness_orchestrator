import { exec } from "../util/exec.js";

/**
 * Atomic task-claim primitive.
 *
 * The claim is a git ref under a private namespace, created with
 * `git update-ref --stdin` using the `create` verb — which atomically fails if
 * the ref already exists. Both harnesses run on the same machine against the
 * same repository, so a *local* ref is a sound mutex and is shared across all
 * worktrees (refs outside refs/worktree/* live in the common ref store).
 *
 * A distributed variant (agents on separate clones) would swap this for a
 * GitHub ref created via `gh api POST /git/refs` (201 = won, 422 = held) —
 * same create-only semantics, different backend.
 */

const LOCK_NS = "refs/orch/lock/issue-";

export type ClaimOutcome = "acquired" | "already-held" | "error";

export interface ClaimResult {
  outcome: ClaimOutcome;
  detail?: string;
}

export function lockRef(issue: number): string {
  return `${LOCK_NS}${issue}`;
}

async function headSha(cwd?: string): Promise<string | null> {
  const r = await exec("git", ["rev-parse", "HEAD"], { cwd });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Attempt to atomically claim an issue. Exactly one racer can win. */
export async function claim(
  issue: number,
  opts: { cwd?: string; sha?: string } = {},
): Promise<ClaimResult> {
  const sha = opts.sha ?? (await headSha(opts.cwd));
  if (!sha) return { outcome: "error", detail: "cannot resolve HEAD (repo has no commits?)" };

  const input = `create ${lockRef(issue)} ${sha}\n`;
  const r = await exec("git", ["update-ref", "--stdin"], { cwd: opts.cwd, input });
  if (r.code === 0) return { outcome: "acquired" };

  const msg = (r.stderr + r.stdout).trim();
  if (/already exists|cannot lock ref|reference already exists/i.test(msg)) {
    return { outcome: "already-held", detail: msg };
  }
  return { outcome: "error", detail: msg };
}

/** Release a claim (called on merge or abandonment). */
export async function release(issue: number, opts: { cwd?: string } = {}): Promise<boolean> {
  const input = `delete ${lockRef(issue)}\n`;
  const r = await exec("git", ["update-ref", "--stdin"], { cwd: opts.cwd, input });
  return r.code === 0;
}

export async function isLocked(issue: number, opts: { cwd?: string } = {}): Promise<boolean> {
  const r = await exec("git", ["show-ref", "--verify", "--quiet", lockRef(issue)], { cwd: opts.cwd });
  return r.code === 0;
}

/** List currently-claimed issue numbers. */
export async function listLocks(opts: { cwd?: string } = {}): Promise<number[]> {
  const r = await exec("git", ["for-each-ref", "--format=%(refname)", "refs/orch/lock/"], { cwd: opts.cwd });
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((ref) => Number(ref.replace(LOCK_NS, "")))
    .filter((n) => Number.isFinite(n));
}
