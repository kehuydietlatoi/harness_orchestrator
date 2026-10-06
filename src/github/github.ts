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

/** Bounded history lookup for one task branch. A full page is ambiguous, so fail
 * explicitly rather than deriving healthy state from a truncated PR history. */
export async function getBranchPrs(branch: string, opts: { cwd?: string } = {}): Promise<Pr[]> {
  const limit = 100;
  const r = await exec("gh", ["pr", "list", "--head", branch, "--state", "all",
    "--limit", String(limit), "--json", PR_FIELDS], { cwd: opts.cwd });
  if (r.code !== 0) throw new Error(`cannot observe PRs for ${branch}: ${r.stderr.trim()}`);
  const prs = (JSON.parse(r.stdout) as unknown[]).map(parsePr);
  if (prs.length >= limit) throw new Error(`cannot observe complete PR history for ${branch}: limit ${limit} reached`);
  return prs;
}

/** One bounded issue-local read also finds PRs with renamed/non-task heads.
 * See https://docs.github.com/en/graphql/reference/issues#crossreferencedevent.
 * The caller still applies the canonical task/PR association to these mentions. */
export async function getIssueReferencedPrs(number: number, opts: { cwd?: string } = {}): Promise<Pr[]> {
  const query = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        timelineItems(first: 100, itemTypes: [CROSS_REFERENCED_EVENT]) {
          pageInfo { hasNextPage }
          nodes { ... on CrossReferencedEvent {
            isCrossRepository
            source { __typename ... on PullRequest { number title body headRefName state url headRefOid } }
          } }
        }
      }
    }
  }`;
  const r = await exec("gh", ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}",
    "-F", `number=${number}`, "-f", `query=${query}`], { cwd: opts.cwd });
  if (r.code !== 0) throw new Error(`cannot observe PR references for #${number}: ${r.stderr.trim()}`);
  const response = JSON.parse(r.stdout) as {
    errors?: unknown[];
    data?: { repository?: { issue?: { timelineItems?: {
      pageInfo: { hasNextPage: boolean };
      nodes: Array<{ isCrossRepository: boolean; source: { __typename: string } } | null>;
    } } } };
  };
  const timeline = response.data?.repository?.issue?.timelineItems;
  if (response.errors?.length || !timeline) throw new Error(`cannot observe PR references for #${number}`);
  if (timeline.pageInfo.hasNextPage) throw new Error(`cannot observe complete PR references for #${number}: limit 100 reached`);
  return timeline.nodes.flatMap((event) =>
    event && !event.isCrossRepository && event.source.__typename === "PullRequest" ? [parsePr(event.source)] : []);
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

/**
 * The PR's unified diff. By default a failure comes back as the text `(diff unavailable: ...)`, which is fine
 * for a human reading `orch review` but is not a diff: anything that *reviews* must pass `strict: true`, which
 * throws instead, so a missing diff can never be mistaken for "nothing suspicious in it".
 */
export async function prDiff(number: number, opts: { cwd?: string; strict?: boolean } = {}): Promise<string> {
  const r = await exec("gh", ["pr", "diff", String(number)], { cwd: opts.cwd });
  if (r.code === 0) return r.stdout;
  if (opts.strict) throw new Error(`could not fetch the diff of PR #${number}: ${r.stderr.trim() || `exit ${r.code}`}`);
  return `(diff unavailable: ${r.stderr.trim()})`;
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

/**
 * CI roll-up for a PR.
 *
 * Lenient by default (the dashboard): output that cannot be read is shown as `fail`. That is the wrong
 * answer for anything that *acts* on the result, because gh also produces unreadable output when it
 * could not ask at all (network, auth, rate limit, API error): a healthy PR would look red. Callers that
 * act pass `strict: true`, which reads whatever JSON gh printed (it exits non-zero while checks fail or
 * are pending but still prints the results) and throws only when there are no results to read.
 */
export async function prChecksState(
  number: number,
  opts: { cwd?: string; strict?: boolean } = {},
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
    if (opts.strict) {
      const why = (r.stderr || r.stdout).trim() || `exit ${r.code}`;
      throw new Error(`could not read the checks of PR #${number}: ${why}`);
    }
    // gh exits non-zero while checks are failing/pending; treat unparseable as fail.
    if (r.code !== 0) return "fail";
  }
  if (!arr.length) return "none";
  const buckets = arr.map((c) => c.bucket);
  if (buckets.some((b) => b === "fail" || b === "cancel")) return "fail";
  if (buckets.some((b) => b === "pending")) return "pending";
  return "pass";
}

export async function mergePr(
  number: number,
  opts: { cwd?: string; method?: "squash" | "merge" | "rebase"; deleteBranch?: boolean; expectedHead?: string; title?: string } = {},
): Promise<void> {
  if (opts.expectedHead) {
    const r = await exec("gh", ["api", `repos/{owner}/{repo}/pulls/${number}/merge`,
      "--method", "PUT", "--input", "-"], {
      cwd: opts.cwd,
      input: JSON.stringify({
        sha: opts.expectedHead,
        merge_method: opts.method ?? "squash",
        // Without a title GitHub defaults to the first commit's message, which is often a working title.
        // Match what `gh pr merge --squash` produces: "<PR title> (#<n>)".
        ...(opts.title && (opts.method ?? "squash") === "squash" ? { commit_title: `${opts.title} (#${number})` } : {}),
      }),
    });
    if (r.code !== 0) throw new Error(`guarded merge #${number} failed: ${r.stderr.trim()}`);
    if (JSON.parse(r.stdout).merged !== true) throw new Error(`GitHub did not merge PR #${number}`);
    // Branch deletion is deliberately left to safe cleanup after confirmed merge.
    return;
  }
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

export interface PrReview {
  id: number;
  body: string;
  state: string;
  commit_id: string;
}

export async function listPrReviews(number: number, opts: { cwd?: string } = {}): Promise<PrReview[]> {
  return paginatedApi<PrReview>(`repos/{owner}/{repo}/pulls/${number}/reviews`, {}, opts);
}

/** COMMENT works when both harnesses share the PR author's GitHub identity. */
export async function recordPrReview(number: number, head: string, body: string, opts: { cwd?: string } = {}): Promise<void> {
  const r = await exec("gh", ["api", `repos/{owner}/{repo}/pulls/${number}/reviews`,
    "--method", "POST", "--input", "-"], {
    cwd: opts.cwd, input: JSON.stringify({ event: "COMMENT", commit_id: head, body }),
  });
  if (r.code !== 0) throw new Error(`record review #${number} failed: ${r.stderr.trim()}`);
}

/** Whether a PR can merge into its base right now. `unknown` while GitHub is still computing it. */
export type Mergeability = "clean" | "conflicting" | "unknown";

export async function prMergeability(number: number, opts: { cwd?: string } = {}): Promise<Mergeability> {
  const r = await exec("gh", ["pr", "view", String(number), "--json", "mergeable", "--jq", ".mergeable"], {
    cwd: opts.cwd,
  });
  if (r.code !== 0) throw new Error(`gh pr view #${number} mergeable failed: ${r.stderr.trim()}`);
  switch (r.stdout.trim()) {
    case "MERGEABLE":
      return "clean";
    case "CONFLICTING":
      return "conflicting";
    default:
      return "unknown";
  }
}

/** Names of the PR's checks that failed or were cancelled (for the author's fix prompt). */
export async function failingChecks(number: number, opts: { cwd?: string } = {}): Promise<string[]> {
  const r = await exec("gh", ["pr", "checks", String(number), "--json", "bucket,name"], { cwd: opts.cwd });
  try {
    const arr = JSON.parse(r.stdout) as { bucket?: string; name?: string }[];
    return arr.filter((c) => c.bucket === "fail" || c.bucket === "cancel").map((c) => c.name ?? "(unnamed check)");
  } catch {
    return [];
  }
}

/** Post a plain comment on a PR (used when the loop escalates a task to a human). */
export async function commentOnPr(number: number, body: string, opts: { cwd?: string } = {}): Promise<void> {
  const r = await exec("gh", ["pr", "comment", String(number), "--body-file", "-"], { cwd: opts.cwd, input: body });
  if (r.code !== 0) throw new Error(`comment on PR #${number} failed: ${r.stderr.trim()}`);
}
