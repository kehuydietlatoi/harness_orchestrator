import { type Issue, listIssues, getIssue } from "./github.js";
import { STATUS } from "./labels.js";
import { isLocked } from "./lock.js";

export function issueStatus(i: Issue): string {
  const s = i.labels.find((l) => l.startsWith("status:"));
  return s ?? STATUS.todo;
}

export function issueAgent(i: Issue): string | null {
  const a = i.labels.find((l) => l.startsWith("agent:"));
  return a ? a.slice("agent:".length) : null;
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

/** True if the issue is available to be claimed by any agent. */
export async function isEligible(i: Issue, cwd?: string): Promise<boolean> {
  const claimed = i.labels.some((l) => l.startsWith("status:") && l !== STATUS.todo);
  if (claimed) return false;
  if (await isLocked(i.number, { cwd })) return false;
  if ((await openDeps(i, cwd)).length > 0) return false;
  return true;
}

/** Eligible issues in ascending issue-number order (stable pick order). */
export async function eligibleIssues(cwd?: string): Promise<Issue[]> {
  const issues = (await listIssues({ cwd, state: "open" })).sort((a, b) => a.number - b.number);
  const out: Issue[] = [];
  for (const i of issues) {
    if (await isEligible(i, cwd)) out.push(i);
  }
  return out;
}
