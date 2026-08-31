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
// REST pagination
// ---------------------------------------------------------------------------

const REST_PAGE_SIZE = 100;

/** Page through a REST list endpoint via `gh api`, following `page`/`per_page`
 * until a page comes back short — the only way to get a complete result set
 * without an artificial cap (the `gh <noun> list` subcommands only take a
 * single `--limit`, which silently truncates instead of paging). */
async function paginatedApi<T>(
  path: string,
  params: Record<string, string>,
  opts: { cwd?: string },
): Promise<T[]> {
  const results: T[] = [];
  for (let page = 1; ; page++) {
    const qs = new URLSearchParams({ ...params, per_page: String(REST_PAGE_SIZE), page: String(page) });
    const r = await exec("gh", ["api", `${path}?${qs.toString()}`], { cwd: opts.cwd });
    if (r.code !== 0) throw new Error(`gh api ${path} failed: ${r.stderr.trim()}`);
    const items = JSON.parse(r.stdout) as T[];
    results.push(...items);
    if (items.length < REST_PAGE_SIZE) return results;
  }
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

/** Ensure each label exists (idempotent, best-effort). A label that fails to
 * create is skipped — the subsequent `--add-label` surfaces any real problem. */
export async function ensureLabels(labels: GhLabel[], cwd: string = process.cwd()): Promise<void> {
  for (const label of labels) await ensureLabel(label, cwd);
}

export async function listLabels(cwd: string = process.cwd()): Promise<string[]> {
  try {
    const labels = await paginatedApi<{ name: string }>("repos/{owner}/{repo}/labels", {}, { cwd });
    return labels.map((l) => l.name);
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

/* eslint-disable @typescript-eslint/no-explicit-any */
function parseRestIssue(o: any): Issue {
  return {
    number: o.number,
    title: o.title ?? "",
    body: o.body ?? "",
    state: String(o.state ?? "open").toUpperCase(),
    labels: (o.labels ?? []).map((l: any) => (typeof l === "string" ? l : (l.name as string))),
    assignees: (o.assignees ?? []).map((a: any) => a.login as string),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function listIssues(
  opts: { cwd?: string; state?: "open" | "closed" | "all" } = {},
): Promise<Issue[]> {
  // The REST issues endpoint also returns PRs (flagged via `pull_request`);
  // filter them out to match `gh issue list` semantics.
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const items = await paginatedApi<any>(
    "repos/{owner}/{repo}/issues",
    { state: opts.state ?? "open" },
    { cwd: opts.cwd },
  );
  return items.filter((o) => !o.pull_request).map(parseRestIssue);
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
  /** Canonical GitHub web URL for the PR (empty when unknown). */
  htmlUrl: string;
  /** Head commit SHA (empty when unknown); used to cache check state per commit. */
  headSha: string;
}

const PR_FIELDS = "number,title,body,headRefName,state,url,headRefOid";

/* eslint-disable @typescript-eslint/no-explicit-any */
function parsePr(o: any): Pr {
  return {
    number: o.number,
    title: o.title ?? "",
    body: o.body ?? "",
    headRefName: o.headRefName ?? "",
    state: String(o.state ?? "OPEN").toUpperCase(),
    htmlUrl: o.url ?? "",
    headSha: o.headRefOid ?? "",
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function getPr(number: number, opts: { cwd?: string } = {}): Promise<Pr> {
  const r = await exec("gh", ["pr", "view", String(number), "--json", PR_FIELDS], { cwd: opts.cwd });
  if (r.code !== 0) throw new Error(`gh pr view #${number} failed: ${r.stderr.trim()}`);
  return parsePr(JSON.parse(r.stdout));
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function parseRestPr(o: any): Pr {
  return {
    number: o.number,
    title: o.title ?? "",
    body: o.body ?? "",
    headRefName: o.head?.ref ?? "",
    state: o.merged_at ? "MERGED" : String(o.state ?? "open").toUpperCase(),
    htmlUrl: o.html_url ?? "",
    headSha: o.head?.sha ?? "",
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function listOpenPrs(opts: { cwd?: string } = {}): Promise<Pr[]> {
  return listPrs({ ...opts, state: "open" });
}

/** The repository's GitHub web URL (e.g. `https://github.com/owner/repo`), or
 * null when it can't be resolved. Best-effort: dashboard links degrade to plain
 * text on failure rather than breaking the snapshot. */
export async function getRepoUrl(opts: { cwd?: string } = {}): Promise<string | null> {
  const r = await exec("gh", ["repo", "view", "--json", "url"], { cwd: opts.cwd });
  if (r.code !== 0) return null;
  try {
    const url = (JSON.parse(r.stdout) as { url?: string }).url;
    return typeof url === "string" && url ? url : null;
  } catch {
    return null;
  }
}

/** List PRs with complete REST pagination. Repair needs closed and merged PRs
 * as well as open ones so it can rebuild lifecycle projections from facts. */
export async function listPrs(
  opts: { cwd?: string; state?: "open" | "closed" | "all" } = {},
): Promise<Pr[]> {
  const items = await paginatedApi<unknown>(
    "repos/{owner}/{repo}/pulls",
    { state: opts.state ?? "all" },
    { cwd: opts.cwd },
  );
  return items.map(parseRestPr);
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

/** CI roll-up for a PR: `none` when no checks are configured, otherwise the
 * worst outstanding bucket. Distinguishes `pending` from `fail` (unlike
 * {@link prChecksPass}, whose boolean the merge gate needs) so the dashboard
 * can show an in-progress state. */
export type ChecksState = "pass" | "fail" | "pending" | "none";

export async function prChecksState(
  number: number,
  opts: { cwd?: string } = {},
): Promise<ChecksState> {
  const r = await exec("gh", ["pr", "checks", String(number), "--json", "bucket,state"], {
    cwd: opts.cwd,
  });
  const combined = r.stdout + r.stderr;
  if (/no checks reported/i.test(combined)) return "none";

  let arr: { bucket?: string }[] = [];
  try {
    arr = JSON.parse(r.stdout);
  } catch {
    // gh exits non-zero while checks are failing/pending; treat unparseable as fail.
    if (r.code !== 0) return "fail";
  }
  if (!arr.length) return "none";
  const buckets = arr.map((c) => c.bucket);
  if (buckets.some((b) => b === "fail" || b === "cancel")) return "fail";
  if (buckets.some((b) => b === "pending")) return "pending";
  return "pass";
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
