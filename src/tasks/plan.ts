import { listIssues, editIssue } from "../github/github.js";
import { agentLabel } from "../github/labels.js";
import { issueAgent, isEligible } from "../board/board.js";
import type { OrchConfig } from "../config.js";

export interface Ticket {
  id?: string; // local id other tickets reference in dependsOn
  title: string;
  body?: string;
  dependsOn?: string[]; // local ids of earlier tickets
  files?: string[]; // file-ownership hints (to minimise overlap)
}

/** Parse a tickets file into the `Ticket[]` shape. Structural + field-type
 * validation \u2014 it must be a JSON array of objects, and any present `id`/`title`/
 * `body` must be a string and any present `dependsOn`/`files` must be an array of
 * strings. Malformed field values are reported (ticket-indexed, all at once) rather
 * than silently dropped or coerced. Per-ticket semantics (missing title, duplicate
 * id, unknown deps) remain the job of `resolvePlan`. Throws on anything that is not
 * shaped like a valid ticket list. */
export function parseTickets(raw: string): Ticket[] {
  const value: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (!Array.isArray(value)) throw new Error("tickets file must be a JSON array");
  const errors: string[] = [];
  const tickets = value.map((t, i) => {
    const index = i + 1;
    if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error(`ticket ${index} must be an object`);
    const o = t as Record<string, unknown>;

    const stringArray = (v: unknown, field: string): string[] | undefined => {
      if (v === undefined) return undefined;
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
        errors.push(`ticket ${index}: ${field} must be an array of strings`);
        return undefined;
      }
      return v;
    };

    if (o.id !== undefined && typeof o.id !== "string") errors.push(`ticket ${index}: id must be a string`);
    if (o.title !== undefined && typeof o.title !== "string") errors.push(`ticket ${index}: title must be a string`);
    if (o.body !== undefined && typeof o.body !== "string") errors.push(`ticket ${index}: body must be a string`);

    return {
      id: typeof o.id === "string" ? o.id : undefined,
      title: typeof o.title === "string" ? o.title : "",
      body: typeof o.body === "string" ? o.body : undefined,
      dependsOn: stringArray(o.dependsOn, "dependsOn"),
      files: stringArray(o.files, "files"),
    };
  });
  if (errors.length) throw new Error(errors.join("; "));
  return tickets;
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
