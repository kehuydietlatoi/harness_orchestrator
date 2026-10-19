import { exec } from "../util/exec.js";
import { createHash, randomUUID } from "node:crypto";
import { lockPathsOverlap, normalizeLockPath } from "./path-locks.js";

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
const PATH_NS = "refs/orch/lock/path/";
// A persistent CAS version, outside the lock namespace; never a held mutex.
const PATH_VERSION = "refs/orch/path-lock-version";

export interface PathLock { ref: string; sha: string; issue: number; path: string; owner: string }

export function pathLockRef(path: string): string {
  return PATH_NS + createHash("sha256").update(normalizeLockPath(path)).digest("hex");
}

async function writeBlob(value: unknown, cwd?: string): Promise<string> {
  const result = await exec("git", ["hash-object", "-w", "--stdin"], { cwd, input: JSON.stringify(value) });
  if (result.code !== 0) throw new Error(`cannot write path lock metadata: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** Strict reads: an unreadable lock must never permit an overlapping claim. */
export async function listPathLocks(opts: { cwd?: string } = {}): Promise<PathLock[]> {
  const result = await exec("git", ["for-each-ref", "--format=%(refname) %(objectname)", PATH_NS], opts);
  if (result.code !== 0) throw new Error(`cannot observe path locks: ${result.stderr.trim()}`);
  return Promise.all(result.stdout.trim().split(/\r?\n/).filter(Boolean).map(async (line) => {
    const [ref, sha] = line.split(" ");
    const blob = await exec("git", ["cat-file", "blob", sha], opts);
    if (blob.code !== 0) throw new Error(`cannot read path lock ${ref}`);
    const data = JSON.parse(blob.stdout);
    if (!Number.isInteger(data.issue) || data.issue <= 0 || typeof data.path !== "string" ||
        typeof data.owner !== "string" || pathLockRef(data.path) !== ref) throw new Error(`invalid path lock ${ref}`);
    return { ref, sha, issue: data.issue, path: data.path, owner: data.owner };
  }));
}

export async function pathsLocked(paths: readonly string[], opts: { cwd?: string } = {}): Promise<boolean> {
  if (!paths.length) return false;
  return (await listPathLocks(opts)).some((held) => paths.some((path) => lockPathsOverlap(path, held.path)));
}

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

/**
 * Create a unique Git object whose id can identify one claim attempt. The
 * object is intentionally created before the lock ref: an unreferenced blob is
 * harmless and lets a caller distinguish its own ambiguous write from a
 * concurrent claimant's lock.
 */
export async function createOwnerToken(
  issue: number,
  agent: string,
  opts: { cwd?: string } = {},
): Promise<string> {
  const marker = JSON.stringify({ issue, agent, nonce: randomUUID() });
  const r = await exec("git", ["hash-object", "-w", "--stdin"], { cwd: opts.cwd, input: marker });
  const sha = r.stdout.trim();
  if (r.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(sha)) {
    throw new Error(`cannot create claim owner token: ${r.stderr.trim() || "invalid object id"}`);
  }
  return sha;
}

/** Attempt to atomically claim an issue. Exactly one racer can win. */
export async function claim(
  issue: number,
  opts: { cwd?: string; sha?: string; paths?: readonly string[] } = {},
): Promise<ClaimResult> {
  const sha = opts.sha ?? (await headSha(opts.cwd));
  if (!sha) return { outcome: "error", detail: "cannot resolve HEAD (repo has no commits?)" };

  const paths = [...new Set((opts.paths ?? []).map(normalizeLockPath))];
  if (paths.length) {
    // Read the version BEFORE the namespace snapshot. Concurrent additions must
    // change it in the same transaction as their refs, so exactly one wins.
    for (let attempt = 0; attempt < 100; attempt++) {
      const version = await exec("git", ["rev-parse", "--verify", "--quiet", PATH_VERSION], { cwd: opts.cwd });
      if (await pathsLocked(paths, opts)) return { outcome: "already-held" };
      const next = await writeBlob({ nonce: randomUUID() }, opts.cwd);
      const entries = await Promise.all(paths.map(async (path) => {
        const blob = await writeBlob({ issue, path, owner: sha }, opts.cwd);
        return `create ${pathLockRef(path)} ${blob}`;
      }));
      const update = version.code === 0 ? `update ${PATH_VERSION} ${next} ${version.stdout.trim()}` : `create ${PATH_VERSION} ${next}`;
      const result = await exec("git", ["update-ref", "--stdin"], {
        cwd: opts.cwd, input: [`create ${lockRef(issue)} ${sha}`, update, ...entries, ""].join("\n"),
      });
      if (result.code === 0) return { outcome: "acquired" };
      if (await isLocked(issue, opts)) return { outcome: "already-held" };
      if (!/cannot lock ref|already exists|reference already exists/i.test(result.stderr + result.stdout)) {
        return { outcome: "error", detail: result.stderr + result.stdout };
      }
    }
    return { outcome: "already-held", detail: "concurrent path claim contention; retry later" };
  }
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
  const current = await owner(issue, opts);
  return current === null ? true : releaseOwned(issue, current, opts);
}

/** Read the exact object id stored in a claim lock, or null when it is absent. */
export async function owner(issue: number, opts: { cwd?: string } = {}): Promise<string | null> {
  const r = await exec("git", ["rev-parse", "--verify", "--quiet", lockRef(issue)], {
    cwd: opts.cwd,
  });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Release only the lock still owned by the supplied claim attempt. */
export async function releaseOwned(
  issue: number,
  expectedOwner: string,
  opts: { cwd?: string } = {},
): Promise<boolean> {
  const paths = (await listPathLocks(opts)).filter((lock) => lock.issue === issue && lock.owner === expectedOwner);
  const input = [`delete ${lockRef(issue)} ${expectedOwner}`, ...paths.map((lock) => `delete ${lock.ref} ${lock.sha}`), ""].join("\n");
  const r = await exec("git", ["update-ref", "--stdin"], { cwd: opts.cwd, input });
  return r.code === 0;
}

export async function isLocked(issue: number, opts: { cwd?: string } = {}): Promise<boolean> {
  const r = await exec("git", ["show-ref", "--verify", "--quiet", lockRef(issue)], { cwd: opts.cwd });
  return r.code === 0;
}

/** List currently-claimed issue numbers. */
export async function listLocks(opts: { cwd?: string; strict?: boolean } = {}): Promise<number[]> {
  const r = await exec("git", ["for-each-ref", "--format=%(refname)", "refs/orch/lock/"], { cwd: opts.cwd });
  if (r.code !== 0) {
    if (opts.strict) throw new Error(`cannot observe claim locks: ${r.stderr.trim()}`);
    return [];
  }
  return r.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((ref) => Number(ref.replace(LOCK_NS, "")))
    .filter((n) => Number.isFinite(n));
}
