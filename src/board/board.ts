import { type Issue, listIssues, getIssue } from "../github/github.js";
import { STATUS } from "../github/labels.js";
import { isLocked } from "../git/lock.js";

export function issueStatus(i: Issue): string {
  const s = i.labels.find((l) => l.startsWith("status:"));
  return s ?? STATUS.todo;
}

export function issueAgent(i: Issue): string | null {
  const a = i.labels.find((l) => l.startsWith("agent:"));
  return a ? a.slice("agent:".length) : null;
}

export function issueEffort(i: Issue): "easy" | "hard" | null {
  for (const label of i.labels) {
    if (label === "effort:easy") return "easy";
    if (label === "effort:hard") return "hard";
  }
  return null;
}

/** Parse `Depends-on: #1, #2` (also "Depends on #3") from an issue body. */
export function parseDeps(body: string): number[] {
  const deps = new Set<number>();
  const re = /depends[-\s]?on:?\s*((?:#\d+[\s,]*)+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    for (const num of m[1].matchAll(/#(\d+)/g)) deps.add(Number(num[1]));
  }
  return [...deps];
}

/** Index a list of issues by their number for O(1) lookup. */
export function byNumber(issues: Issue[]): Map<number, Issue> {
  return new Map(issues.map((i) => [i.number, i]));
}

/**
 * Still-open dependency issue numbers, resolved from a pre-fetched open-issue map
 * (empty = not blocked). A dependency absent from the map — closed, missing, or
 * inaccessible — is treated as non-blocking, matching `openDeps`.
 */
export function openDepsFromMap(issue: Issue, open: Map<number, Issue>): number[] {
  const blocking: number[] = [];
  for (const d of parseDeps(issue.body)) {
    const di = open.get(d);
    if (di && di.state !== "CLOSED") blocking.push(d);
  }
  return blocking;
}

/** Returns the still-open dependency issue numbers (empty = not blocked). */
export async function openDeps(issue: Issue, cwd?: string): Promise<number[]> {
  const blocking: number[] = [];
  for (const d of parseDeps(issue.body)) {
    try {
      const di = await getIssue(d, { cwd });
      if (di.state !== "CLOSED") blocking.push(d);
    } catch {
      /* missing/inaccessible dependency: do not treat as blocking */
    }
  }
  return blocking;
}

/**
 * True if the issue is available to be claimed by any agent.
 *
 * When `open` (the batched open-issue map) is supplied, dependency state is
 * resolved from it — avoiding a per-dependency `gh` lookup. Otherwise deps are
 * fetched individually via `openDeps` (used by callers without a batched list).
 */
export async function isEligible(
  i: Issue,
  cwd?: string,
  open?: Map<number, Issue>,
): Promise<boolean> {
  const claimed = i.labels.some((l) => l.startsWith("status:") && l !== STATUS.todo);
  if (claimed) return false;
  if (await isLocked(i.number, { cwd })) return false;
  const blocking = open ? openDepsFromMap(i, open) : await openDeps(i, cwd);
  if (blocking.length > 0) return false;
  return true;
}

/** Eligible issues in ascending issue-number order (stable pick order). */
export async function eligibleIssues(cwd?: string): Promise<Issue[]> {
  const issues = (await listIssues({ cwd, state: "open" })).sort((a, b) => a.number - b.number);
  const open = byNumber(issues);
  const out: Issue[] = [];
  for (const i of issues) {
    if (await isEligible(i, cwd, open)) out.push(i);
  }
  return out;
}
