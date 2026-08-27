import { exec } from "../util/exec.js";

export interface RepositoryBase {
  /** Branch name as GitHub expects it (for example, `main` or `release/v2`). */
  name: string;
  /** Validated local Git ref used for ancestry and commit comparisons. */
  ref: string;
}

export type BranchComparison = "absent" | "unchanged" | "ahead";

function commandFailure(command: string, stderr: string): Error {
  const detail = stderr.trim();
  return new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
}

async function refExists(ref: string, cwd: string): Promise<boolean> {
  const result = await exec("git", ["show-ref", "--verify", "--quiet", ref], { cwd });
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw commandFailure(`git show-ref ${ref}`, result.stderr);
}

/**
 * Resolve the configured base branch, or ask GitHub for the repository default,
 * then prove that it has a usable local or origin-tracking ref. Keeping the
 * GitHub name separate from the Git ref prevents `origin/main` from leaking into
 * the PR base while still supporting clones without a local base branch.
 */
export async function resolveBaseBranch(
  configured: string | undefined,
  cwd: string = process.cwd(),
): Promise<RepositoryBase> {
  let name: string;
  if (configured !== undefined) {
    name = configured.trim();
    if (!name) throw new Error("configured baseBranch must not be empty");
  } else {
    const result = await exec(
      "gh",
      ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      { cwd },
    );
    if (result.code !== 0) {
      throw commandFailure("GitHub default branch lookup", result.stderr);
    }
    name = result.stdout.trim();
    if (!name || name === "null") {
      throw new Error("GitHub default branch lookup returned no branch");
    }
  }

  const valid = await exec("git", ["check-ref-format", "--branch", name], { cwd });
  if (valid.code !== 0) throw new Error(`invalid base branch '${name}'`);

  const local = `refs/heads/${name}`;
  if (await refExists(local, cwd)) return { name, ref: local };

  const remote = `refs/remotes/origin/${name}`;
  if (await refExists(remote, cwd)) return { name, ref: remote };

  throw new Error(
    `base branch '${name}' is missing: expected '${local}' or '${remote}'`,
  );
}

/**
 * Count commits reachable from `head` but not `base`. Both Git commands are
 * mandatory: merge-base proves the histories are comparable, and rev-list
 * supplies the count. A missing ref, unrelated history, command failure, or
 * malformed count is an observation error, never zero commits.
 */
export async function countCommitsAhead(
  base: string,
  head: string,
  cwd: string = process.cwd(),
): Promise<number> {
  const common = await exec("git", ["merge-base", base, head], { cwd });
  if (common.code !== 0) throw commandFailure("git merge-base", common.stderr);
  if (!common.stdout.trim()) throw new Error("git merge-base returned no commit");

  const result = await exec("git", ["rev-list", "--count", `${base}..${head}`], { cwd });
  if (result.code !== 0) throw commandFailure("git rev-list", result.stderr);
  const text = result.stdout.trim();
  if (!/^\d+$/.test(text)) throw new Error(`git rev-list returned an invalid count: '${text}'`);
  return Number(text);
}

/** Observe a task branch relative to the validated repository base. */
export async function compareBranchToBase(
  branch: string,
  base: RepositoryBase,
  cwd: string = process.cwd(),
): Promise<BranchComparison> {
  const ref = `refs/heads/${branch}`;
  if (!(await refExists(ref, cwd))) return "absent";
  return (await countCommitsAhead(base.ref, ref, cwd)) > 0 ? "ahead" : "unchanged";
}

export async function isGitRepo(cwd: string = process.cwd()): Promise<boolean> {
  const r = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  return r.code === 0 && r.stdout.trim() === "true";
}

export async function gitVersion(): Promise<string> {
  const r = await exec("git", ["--version"]);
  return r.stdout.trim();
}

export async function remoteUrl(cwd: string = process.cwd()): Promise<string | null> {
  const r = await exec("git", ["remote", "get-url", "origin"], { cwd });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** git worktree add landed in 2.5 and stabilised by 2.15. */
export async function supportsWorktree(): Promise<boolean> {
  const v = await gitVersion(); // e.g. "git version 2.40.0.windows.1"
  const m = v.match(/(\d+)\.(\d+)/);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 2 || (major === 2 && minor >= 15);
}
