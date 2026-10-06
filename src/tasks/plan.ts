import { listIssues, editIssue } from "../github/github.js";
import { agentLabel } from "../github/labels.js";
import { issueAgent, isEligible } from "../board/board.js";
import type { EffortTier, OrchConfig } from "../config.js";

export interface Ticket {
  id?: string; // local id other tickets reference in dependsOn or after
  title: string;
  body?: string;
  dependsOn?: string[]; // local ids of earlier tickets
  after?: string[]; // earlier ticket ids: ordering preferences only
  files?: string[]; // file-ownership hints (to minimise overlap)
  agent?: string; // routing chosen while planning: becomes the `agent:` label
  effort?: string; // routing tier (`easy` | `hard`): becomes the `effort:` label
}

/** Longest plan brief embedded in every issue; longer is a blocking error, never truncated. */
export const MAX_BRIEF_CHARS = 4000;

const EFFORT_TIERS: readonly string[] = ["easy", "hard"];

/** Parse a tickets file into the `Ticket[]` shape. Structural + field-type
 * validation \u2014 it must be a JSON array of objects, and any present `id`/`title`/
 * `body`/`agent`/`effort` must be a string and any present `dependsOn`/`after`/`files` must be an array of
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
    if (o.agent !== undefined && typeof o.agent !== "string") errors.push(`ticket ${index}: agent must be a string`);
    if (o.effort !== undefined && typeof o.effort !== "string") errors.push(`ticket ${index}: effort must be a string`);

    return {
      id: typeof o.id === "string" ? o.id : undefined,
      title: typeof o.title === "string" ? o.title : "",
      body: typeof o.body === "string" ? o.body : undefined,
      dependsOn: stringArray(o.dependsOn, "dependsOn"),
      after: stringArray(o.after, "after"),
      files: stringArray(o.files, "files"),
      ...(typeof o.agent === "string" ? { agent: o.agent } : {}),
      ...(typeof o.effort === "string" ? { effort: o.effort } : {}),
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
  after: string[];
  /** Advisory ids resolving to earlier tickets (will become After: #refs). */
  knownAfter: string[];
  /** Validated routing (labels at creation); absent means the judge routes the ticket. */
  agent?: string;
  effort?: EffortTier;
}

export interface ResolveOptions {
  /** Configured agents. When given, a ticket routed to any other agent is dropped (warning). */
  agents?: readonly string[];
  /** The plan brief embedded in every issue; an over-long brief is a blocking error. */
  brief?: string;
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
 * Errors (missing title, duplicate id, an over-long brief) block creation; warnings
 * (a dependency on an unknown/later/self id, an unknown agent or effort \u2014 each
 * dropped \u2014 or a file claimed by two tickets) are advisory. Dependency resolution
 * mirrors creation order: a dep counts as "known" only if it names an *earlier*
 * ticket, since that is the one whose issue number will exist by the time this
 * ticket is created. Routing is whole-or-nothing for the judge, which fills only
 * issues with neither label: an `effort` without an `agent` is dropped. Pure.
 */
export function resolvePlan(tickets: readonly Ticket[], opts: ResolveOptions = {}): ResolvedPlan {
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

    const after = t.after ?? [];
    const knownAfter: string[] = [];
    for (const predecessor of after) {
      if (predecessor === t.id) warnings.push(`ticket ${index} ("${predecessor}") is after itself; dropped`);
      else if (!seen.has(predecessor)) warnings.push(`ticket ${index} is after unknown/later id "${predecessor}"; dropped`);
      else knownAfter.push(predecessor);
    }

    const files = t.files ?? [];
    for (const f of files) fileOwners.set(f, [...(fileOwners.get(f) ?? []), index]);

    let agent = t.agent?.trim() || undefined;
    if (agent && opts.agents && !opts.agents.includes(agent)) {
      warnings.push(`ticket ${index} is routed to unknown agent "${agent}"; dropped (the judge will route it)`);
      agent = undefined;
    }
    let effort = t.effort?.trim() || undefined;
    if (effort && !EFFORT_TIERS.includes(effort)) {
      warnings.push(`ticket ${index} has unknown effort "${effort}" (use easy or hard); dropped`);
      effort = undefined;
    }
    if (effort && !agent) {
      warnings.push(`ticket ${index} has an effort but no agent; dropped so the judge routes it whole`);
      effort = undefined;
    }

    if (t.id) seen.add(t.id);
    resolved.push({
      index, id: t.id, title: t.title, body: (t.body ?? "").trim(), files, dependsOn, knownDeps, after, knownAfter,
      ...(agent ? { agent } : {}),
      ...(effort ? { effort: effort as EffortTier } : {}),
    });
  });

  for (const [file, owners] of fileOwners) {
    if (owners.length > 1) warnings.push(`file "${file}" is claimed by tickets ${owners.join(", ")}`);
  }

  const brief = opts.brief?.trim() ?? "";
  if (brief.length > MAX_BRIEF_CHARS) {
    errors.push(`plan brief is ${brief.length} characters (limit ${MAX_BRIEF_CHARS}); shorten it rather than lose part of it`);
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
