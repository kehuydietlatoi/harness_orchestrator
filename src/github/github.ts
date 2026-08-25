import { exec } from "../util/exec.js";

export interface GhLabel {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: string; // OPEN | CLOSED
  labels: string[];
  assignees: string[];
}

export async function ghInstalled(): Promise<boolean> {
  const r = await exec("gh", ["--version"]);
  return r.code === 0;
}

export async function ghAuthenticated(): Promise<boolean> {
  const r = await exec("gh", ["auth", "status"]);
  return r.code === 0;
}

export async function currentLogin(opts: { cwd?: string } = {}): Promise<string> {
  const r = await exec("gh", ["api", "user", "--jq", ".login"], { cwd: opts.cwd });
  return r.code === 0 ? r.stdout.trim() : "";
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export async function ensureLabel(
  label: GhLabel,
  cwd: string = process.cwd(),
): Promise<"created" | "exists" | "error"> {
  const r = await exec(
    "gh",
    ["label", "create", label.name, "--color", label.color, "--description", label.description],
    { cwd },
  );
  if (r.code === 0) return "created";
  if (/already exists/i.test(r.stderr)) return "exists";
  return "error";
}

export async function listLabels(cwd: string = process.cwd()): Promise<string[]> {
  const r = await exec("gh", ["label", "list", "--json", "name", "-L", "200"], { cwd });
  if (r.code !== 0) return [];
  try {
    return (JSON.parse(r.stdout) as { name: string }[]).map((l) => l.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

const ISSUE_FIELDS = "number,title,body,state,labels,assignees";

/* eslint-disable @typescript-eslint/no-explicit-any */
function parseIssue(o: any): Issue {
  return {
    number: o.number,
    title: o.title ?? "",
    body: o.body ?? "",
    state: String(o.state ?? "OPEN").toUpperCase(),
    labels: (o.labels ?? []).map((l: any) => l.name as string),
    assignees: (o.assignees ?? []).map((a: any) => a.login as string),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function listIssues(
  opts: { cwd?: string; state?: "open" | "closed" | "all" } = {},
): Promise<Issue[]> {
  const r = await exec(
    "gh",
    ["issue", "list", "--state", opts.state ?? "open", "--json", ISSUE_FIELDS, "--limit", "200"],
    { cwd: opts.cwd },
  );
  if (r.code !== 0) throw new Error(`gh issue list failed: ${r.stderr.trim()}`);
  return (JSON.parse(r.stdout) as unknown[]).map(parseIssue);
}

export async function getIssue(number: number, opts: { cwd?: string } = {}): Promise<Issue> {
  const r = await exec("gh", ["issue", "view", String(number), "--json", ISSUE_FIELDS], {
    cwd: opts.cwd,
  });
  if (r.code !== 0) throw new Error(`gh issue view #${number} failed: ${r.stderr.trim()}`);
  return parseIssue(JSON.parse(r.stdout));
}

export async function createIssue(
  title: string,
  body: string,
  labels: string[],
  opts: { cwd?: string } = {},
): Promise<number> {
  const args = ["issue", "create", "--title", title, "--body", body];
  for (const l of labels) args.push("--label", l);
  const r = await exec("gh", args, { cwd: opts.cwd });
  if (r.code !== 0) throw new Error(`gh issue create failed: ${r.stderr.trim()}`);
  const m = r.stdout.match(/\/issues\/(\d+)/);
  if (!m) throw new Error(`could not parse issue number from: ${r.stdout.trim()}`);
  return Number(m[1]);
}

export async function editIssue(
  number: number,
  opts: {
    cwd?: string;
    addLabels?: string[];
    removeLabels?: string[];
    addAssignees?: string[];
    removeAssignees?: string[];
  } = {},
): Promise<void> {
  const args = ["issue", "edit", String(number)];
  for (const l of opts.addLabels ?? []) args.push("--add-label", l);
  for (const l of opts.removeLabels ?? []) args.push("--remove-label", l);
  for (const a of opts.addAssignees ?? []) args.push("--add-assignee", a);
  for (const a of opts.removeAssignees ?? []) args.push("--remove-assignee", a);
  if (args.length === 3) return; // nothing to change
  const r = await exec("gh", args, { cwd: opts.cwd });
  if (r.code !== 0) throw new Error(`gh issue edit #${number} failed: ${r.stderr.trim()}`);
}

export async function closeIssue(number: number, opts: { cwd?: string } = {}): Promise<void> {
  await exec("gh", ["issue", "close", String(number)], { cwd: opts.cwd });
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export async function createPr(opts: {
  cwd?: string;
  title: string;
  body: string;
  base?: string;
  head?: string;
  draft?: boolean;
}): Promise<string> {
  const args = ["pr", "create", "--title", opts.title, "--body", opts.body];
  if (opts.base) args.push("--base", opts.base);
  if (opts.head) args.push("--head", opts.head);
  if (opts.draft) args.push("--draft");
  const r = await exec("gh", args, { cwd: opts.cwd });
  if (r.code !== 0) throw new Error(`gh pr create failed: ${r.stderr.trim()}`);
  // gh prints the PR URL as the last line of stdout
  const lines = r.stdout.trim().split("\n").filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

export interface Pr {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  state: string;
}

const PR_FIELDS = "number,title,body,headRefName,state";

/* eslint-disable @typescript-eslint/no-explicit-any */
function parsePr(o: any): Pr {
  return {
    number: o.number,
    title: o.title ?? "",
    body: o.body ?? "",
    headRefName: o.headRefName ?? "",
    state: String(o.state ?? "OPEN").toUpperCase(),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function getPr(number: number, opts: { cwd?: string } = {}): Promise<Pr> {
  const r = await exec("gh", ["pr", "view", String(number), "--json", PR_FIELDS], { cwd: opts.cwd });
  if (r.code !== 0) throw new Error(`gh pr view #${number} failed: ${r.stderr.trim()}`);
  return parsePr(JSON.parse(r.stdout));
}

export async function listOpenPrs(opts: { cwd?: string } = {}): Promise<Pr[]> {
  const r = await exec(
    "gh",
    ["pr", "list", "--state", "open", "--json", PR_FIELDS, "--limit", "200"],
    { cwd: opts.cwd },
  );
  if (r.code !== 0) throw new Error(`gh pr list failed: ${r.stderr.trim()}`);
  return (JSON.parse(r.stdout) as unknown[]).map(parsePr);
}

export async function prDiff(number: number, opts: { cwd?: string } = {}): Promise<string> {
  const r = await exec("gh", ["pr", "diff", String(number)], { cwd: opts.cwd });
  return r.code === 0 ? r.stdout : `(diff unavailable: ${r.stderr.trim()})`;
}

/** Are the PR's required checks green? No checks configured counts as pass. */
export async function prChecksPass(
  number: number,
  opts: { cwd?: string } = {},
): Promise<{ pass: boolean; detail: string }> {
  const r = await exec("gh", ["pr", "checks", String(number), "--json", "bucket,name,state"], {
    cwd: opts.cwd,
  });
  const combined = r.stdout + r.stderr;
  if (/no checks reported/i.test(combined)) return { pass: true, detail: "no checks configured" };

  let arr: { bucket?: string; name?: string }[] = [];
  try {
    arr = JSON.parse(r.stdout);
  } catch {
    // gh exits non-zero when checks are failing/pending; fall through to a conservative fail
    if (r.code !== 0) return { pass: false, detail: "checks not green (unparseable)" };
  }
  if (!arr.length) return { pass: true, detail: "no checks" };
  const notPassing = arr.filter((c) => c.bucket !== "pass" && c.bucket !== "skipping");
  return notPassing.length === 0
    ? { pass: true, detail: `${arr.length} check(s) passed` }
    : { pass: false, detail: `${notPassing.length} check(s) not passing` };
}

export async function reviewPr(
  number: number,
  decision: "approve" | "request-changes" | "comment",
  body: string,
  opts: { cwd?: string } = {},
): Promise<void> {
  const flag =
    decision === "approve"
      ? "--approve"
      : decision === "request-changes"
        ? "--request-changes"
        : "--comment";
  const args = ["pr", "review", String(number), flag];
  if (body) args.push("--body", body);
  const r = await exec("gh", args, { cwd: opts.cwd });
  if (r.code !== 0) {
    // GitHub forbids approving your own PR. Both agents share one GitHub user,
    // so approval is tracked by orch labels instead; treat this as non-fatal.
    if (/can not approve your own|your own pull request/i.test(r.stderr)) return;
    throw new Error(`gh pr review #${number} failed: ${r.stderr.trim()}`);
  }
}

export async function mergePr(
  number: number,
  opts: { cwd?: string; method?: "squash" | "merge" | "rebase"; deleteBranch?: boolean } = {},
): Promise<void> {
  const args = ["pr", "merge", String(number), `--${opts.method ?? "squash"}`];
  if (opts.deleteBranch !== false) args.push("--delete-branch");
  const r = await exec("gh", args, { cwd: opts.cwd });
  if (r.code !== 0) {
    // The remote merge succeeds first; only the local `--delete-branch` cleanup
    // can fail when that branch is still checked out in the task worktree (the
    // worktree is pruned by the caller right after this call). Treat that as a
    // successful merge — the PR is merged and the local branch is cleaned up on
    // prune — rather than a merge failure that would skip lock/worktree release.
    if (/Cannot delete branch .* checked out at/i.test(r.stderr)) return;
    throw new Error(`gh pr merge #${number} failed: ${r.stderr.trim()}`);
  }
}
