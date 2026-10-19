import { exec } from "../util/exec.js";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

const baseFetches = new Map<string, { ref: string; done: Promise<void> }>();

/** Linked worktrees share refs. Coalesce the same base, serialize different bases. */
async function fetchBase(name: string, cwd: string): Promise<void> {
  const common = await exec("git", ["rev-parse", "--git-common-dir"], { cwd });
  if (common.code !== 0) throw commandFailure("git rev-parse --git-common-dir", common.stderr);
  const canonical = await realpath(resolve(cwd, common.stdout.trim()));
  const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const remote = `refs/remotes/origin/${name}`;
  for (;;) {
    const running = baseFetches.get(key);
    if (running) {
      await running.done;
      if (running.ref === remote) return;
      continue;
    }
    const done = (async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const fetched = await exec("git", [
          "fetch", "--no-tags", "origin", `+refs/heads/${name}:${remote}`,
        ], { cwd });
        if (fetched.code === 0) return;
        if (attempt !== 0 || !/cannot lock ref/i.test(fetched.stderr)) {
          throw commandFailure(`git fetch origin ${name}`, fetched.stderr);
        }
        // An external fetch may have moved the ref. Re-observe before retrying;
        // a missing ref is valid on a first fetch, other read errors fail closed.
        const current = await exec("git", ["rev-parse", "--verify", "--quiet", remote], { cwd });
        if (current.code !== 0 && current.code !== 1) {
          throw commandFailure(`git rev-parse ${remote}`, current.stderr);
        }
      }
    })();
    baseFetches.set(key, { ref: remote, done });
    try { await done; } finally { baseFetches.delete(key); }
    return;
  }
}

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
 * then prefer its origin-tracking ref, rejecting unpushed local base history.
 * Claims request a fetch; read-only observers use the cached refs. Keeping the
 * GitHub name separate from the Git ref prevents `origin/main` from leaking into
 * the PR base while still supporting clones without a local base branch.
 */
export async function resolveBaseBranch(
  configured: string | undefined,
  cwd: string = process.cwd(),
  opts: { fetch?: boolean } = {},
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
  const remote = `refs/remotes/origin/${name}`;
  if (opts.fetch) {
    // Explicit destination also works in single-branch clones whose configured
    // fetch refspec does not include this base. Never alter the operator's branch.
    await fetchBase(name, cwd);
  }
  const hasLocal = await refExists(local, cwd);
  if (await refExists(remote, cwd)) {
    if (hasLocal) {
      const tip = await exec("git", ["rev-parse", "--verify", `${remote}^{commit}`], { cwd });
      if (tip.code !== 0) throw commandFailure("git rev-parse", tip.stderr);
      const relation = await relateBranchToCommit(name, tip.stdout.trim(), cwd);
      if (relation === "ahead" || relation === "diverged") {
        throw new Error(
          `local base branch '${name}' is ${relation} relative to origin/${name}; reconcile it before continuing`,
        );
      }
    }
    return { name, ref: remote };
  }
  if (hasLocal && !opts.fetch) return { name, ref: local };

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

/**
 * Refresh an unattached task branch before re-claiming it. Only a branch with
 * no history of its own may advance. Return the missing base commit count for
 * preserved work, so the caller can report it without rewriting that work.
 */
export async function refreshTaskBranch(
  branch: string,
  baseRef: string,
  cwd: string,
): Promise<number> {
  const ref = `refs/heads/${branch}`;
  if (!(await refExists(ref, cwd))) return 0;
  const tipOf = async (ref: string): Promise<string> => {
    const result = await exec("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd });
    if (result.code !== 0) throw commandFailure("git rev-parse", result.stderr);
    const tip = result.stdout.trim();
    if (!tip) throw new Error("git rev-parse returned no commit");
    return tip;
  };
  // Pin both observations, and compare-and-set the branch so concurrent work
  // cannot be overwritten between the ancestry check and the ref update.
  const tip = await tipOf(ref);
  const base = await tipOf(baseRef);
  if (tip === base) return 0;
  if (await countCommitsAhead(base, tip, cwd)) {
    return countCommitsAhead(tip, base, cwd);
  }
  const worktrees = await exec("git", ["worktree", "list", "--porcelain"], { cwd });
  if (worktrees.code !== 0) throw commandFailure("git worktree list", worktrees.stderr);
  if (worktrees.stdout.split(/\r?\n/).includes(`branch ${ref}`)) {
    throw new Error(`cannot refresh checked-out task branch '${branch}'`);
  }
  const updated = await exec("git", ["update-ref", ref, base, tip], { cwd });
  if (updated.code !== 0) throw commandFailure("git update-ref", updated.stderr);
  return 0;
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

/** Observe a commit (e.g. an open PR head) relative to the validated repository base. */
export async function compareCommitToBase(
  commit: string,
  base: RepositoryBase,
  cwd: string = process.cwd(),
): Promise<Exclude<BranchComparison, "absent">> {
  return (await countCommitsAhead(base.ref, commit, cwd)) > 0 ? "ahead" : "unchanged";
}

export async function commitExists(commit: string, cwd: string = process.cwd()): Promise<boolean> {
  const r = await exec("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd });
  return r.code === 0;
}

export type BranchRelation = "equal" | "behind" | "ahead" | "diverged";

/** Relate a local branch to a commit it is expected to track. Both must exist. */
export async function relateBranchToCommit(
  branch: string,
  commit: string,
  cwd: string = process.cwd(),
): Promise<BranchRelation> {
  const ref = `refs/heads/${branch}`;
  const tip = await exec("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd });
  if (tip.code !== 0) throw commandFailure("git rev-parse", tip.stderr);
  if (tip.stdout.trim() === commit) return "equal";
  const isAncestor = async (a: string, b: string): Promise<boolean> => {
    const r = await exec("git", ["merge-base", "--is-ancestor", a, b], { cwd });
    // Exit 1 is a definite "no"; anything else is an observation failure.
    if (r.code === 0) return true;
    if (r.code === 1) return false;
    throw commandFailure("git merge-base --is-ancestor", r.stderr);
  };
  if (await isAncestor(ref, commit)) return "behind";
  if (await isAncestor(commit, ref)) return "ahead";
  return "diverged";
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
