import { readFileSync } from "node:fs";
import { createIssue, listIssues, editIssue } from "../github/github.js";
import { STATUS, agentLabel } from "../github/labels.js";
import { issueAgent, isEligible } from "../board/board.js";
import type { OrchConfig } from "../config.js";

export interface Ticket {
  id?: string; // local id other tickets reference in dependsOn
  title: string;
  body?: string;
  dependsOn?: string[]; // local ids of earlier tickets
  files?: string[]; // file-ownership hints (to minimise overlap)
}

/** Pure: render the GitHub issue body from a ticket + resolved dependency numbers. */
export function renderTicketBody(ticket: Ticket, depNumbers: number[]): string {
  const parts: string[] = [];
  if (ticket.body) parts.push(ticket.body.trim());
  if (ticket.files?.length) {
    parts.push(`**Files (ownership hint):** ${ticket.files.map((f) => `\`${f}\``).join(", ")}`);
  }
  if (depNumbers.length) {
    parts.push(`Depends-on: ${depNumbers.map((n) => `#${n}`).join(", ")}`);
  }
  return parts.join("\n\n") || "_(no description)_";
}

export interface Created {
  id?: string;
  number: number;
  title: string;
}

/** Parse a tickets file into the `Ticket[]` shape. Structural validation only \u2014
 * it must be a JSON array of objects; per-ticket semantics (title, deps) are the
 * job of `resolvePlan`. Throws on anything that is not shaped like a ticket list. */
export function parseTickets(raw: string): Ticket[] {
  const value: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (!Array.isArray(value)) throw new Error("tickets file must be a JSON array");
  return value.map((t, i) => {
    if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error(`ticket ${i + 1} must be an object`);
    const o = t as Record<string, unknown>;
    const strings = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
    return {
      id: typeof o.id === "string" ? o.id : undefined,
      title: typeof o.title === "string" ? o.title : "",
      body: typeof o.body === "string" ? o.body : undefined,
      dependsOn: strings(o.dependsOn),
      files: strings(o.files),
    };
  });
}

export interface ResolvedTicket {
  /** 1-based position in the file. */
  index: number;
  id?: string;
  title: string;
  /** The human description (no rendered dep line). */
  body: string;
  files: string[];
  /** Dependency ids as written. */
  dependsOn: string[];
  /** The subset of `dependsOn` that resolves to an earlier ticket (will become #refs). */
  knownDeps: string[];
}

export interface ResolvedPlan {
  tickets: ResolvedTicket[];
  /** Block creation. */
  errors: string[];
  /** Advisory only. */
  warnings: string[];
}

/**
 * Validate + annotate a ticket list without any IO \u2014 the single source of truth
 * behind `orch plan --dry-run`, the dashboard preview, and the create gate.
 *
 * Errors (missing title, duplicate id) block creation; warnings (a dependency on
 * an unknown/later/self id \u2014 which is dropped \u2014 or a file claimed by two tickets)
 * are advisory. Dependency resolution mirrors creation order: a dep counts as
 * "known" only if it names an *earlier* ticket, since that is the one whose issue
 * number will exist by the time this ticket is created. Pure.
 */
export function resolvePlan(tickets: readonly Ticket[]): ResolvedPlan {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const fileOwners = new Map<string, number[]>();
  const resolved: ResolvedTicket[] = [];

  tickets.forEach((t, i) => {
    const index = i + 1;
    if (!t.title.trim()) errors.push(`ticket ${index} needs a title`);
    if (t.id && seen.has(t.id)) errors.push(`ticket ${index}: duplicate id "${t.id}"`);

    const dependsOn = t.dependsOn ?? [];
    const knownDeps: string[] = [];
    for (const dep of dependsOn) {
      if (dep === t.id) warnings.push(`ticket ${index} ("${dep}") depends on itself; dropped`);
      else if (!seen.has(dep)) warnings.push(`ticket ${index} depends on unknown/later id "${dep}"; dropped`);
      else knownDeps.push(dep);
    }

    const files = t.files ?? [];
    for (const f of files) fileOwners.set(f, [...(fileOwners.get(f) ?? []), index]);

    if (t.id) seen.add(t.id);
    resolved.push({ index, id: t.id, title: t.title, body: (t.body ?? "").trim(), files, dependsOn, knownDeps });
  });

  for (const [file, owners] of fileOwners) {
    if (owners.length > 1) warnings.push(`file "${file}" is claimed by tickets ${owners.join(", ")}`);
  }

  return { tickets: resolved, errors, warnings };
}

/** Create GitHub issues from parsed tickets, wiring `dependsOn` to real #numbers.
 * Refuses (throws) if `resolvePlan` reports blocking errors. */
export async function createFromPlan(tickets: readonly Ticket[], cwd: string): Promise<Created[]> {
  const { errors } = resolvePlan(tickets);
  if (errors.length) throw new Error(`invalid tickets: ${errors.join("; ")}`);

  const created: Created[] = [];
  const idToNumber = new Map<string, number>();
  for (const t of tickets) {
    const depNumbers = (t.dependsOn ?? [])
      .map((d) => idToNumber.get(d))
      .filter((n): n is number => n !== undefined);
    const body = renderTicketBody(t, depNumbers);
    const number = await createIssue(t.title, body, [STATUS.todo], { cwd });
    if (t.id) idToNumber.set(t.id, number);
    created.push({ id: t.id, number, title: t.title });
  }
  return created;
}

/** Read a JSON tickets file and create the issues. */
export function planFromFile(file: string, cwd: string): Promise<Created[]> {
  return createFromPlan(parseTickets(readFileSync(file, "utf8")), cwd);
}

export interface Assignment {
  issue: number;
  agent: string;
}

/** Round-robin pre-assign eligible unowned issues to agents (a lead hint). */
export async function assignRoundRobin(cfg: OrchConfig, cwd: string): Promise<Assignment[]> {
  const issues = (await listIssues({ cwd, state: "open" })).sort((a, b) => a.number - b.number);
  const out: Assignment[] = [];
  let i = 0;
  for (const issue of issues) {
    if (issueAgent(issue)) continue; // already owned
    if (!(await isEligible(issue, cwd))) continue; // only actionable todo issues
    const agent = cfg.agents[i % cfg.agents.length];
    i++;
    await editIssue(issue.number, { cwd, addLabels: [agentLabel(agent)] });
    out.push({ issue: issue.number, agent });
  }
  return out;
}
