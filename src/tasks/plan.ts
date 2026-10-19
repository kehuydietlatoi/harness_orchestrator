import { designReferenceErrors, type DesignContext } from "./brief-context.js";
import { listIssues, editIssue } from "../github/github.js";
import { agentLabel } from "../github/labels.js";
import { issueAgent, isEligible } from "../board/board.js";
import { normalizeEffort, type TierAliases, type EffortTier, type OrchConfig } from "../config.js";
import { definitionOfDoneWarnings } from "./definition-of-done.js";
import type { Budget } from "./budget.js";
import { lockPathsOverlap, normalizeLockPath } from "../git/path-locks.js";
import { routeFamily } from "../routing/route-policy.js";

export interface TicketV2 {
  role?: string;
  kind?: "code" | "asset" | "design-data" | "qa" | "prototype" | "docs";
  milestone?: string;
  decisions?: string[];
  context?: string[];
  locks?: string[];
  verify?: string[][];
  needs?: ("shell" | "vision" | "web" | "engine" | "image-gen" | "audio-gen")[];
  sensitivity?: "public" | "internal" | "secret";
  budget?: Budget;
  model?: string;
}

export const V2_FIELDS = ["role", "kind", "milestone", "decisions", "context", "locks", "verify", "needs", "sensitivity", "budget", "model"] as const;

/** Pure projection; these fields never contribute to plan marker identities. */
export function ticketV2Fields(ticket: TicketV2): TicketV2 {
  return Object.fromEntries(V2_FIELDS.filter((key) => ticket[key] !== undefined).map((key) => [key, ticket[key]]));
}

export interface Ticket extends TicketV2 {
  id?: string; // local id other tickets reference in dependsOn or after
  title: string;
  body?: string;
  dependsOn?: string[]; // local ids of earlier tickets
  after?: string[]; // earlier ticket ids: ordering preferences only
  files?: string[]; // file-ownership hints (to minimise overlap)
  agent?: string; // routing chosen while planning: becomes the `agent:` label
  effort?: string; // routing tier (`free` | `cheap` | `standard` | `lead`): becomes the `effort:` label
  acceptance?: string[]; // the definition of done: checks a test or command can verify
  outOfScope?: string[]; // tempting adjacent work this ticket does not do
}

/** Longest plan brief embedded in every issue; longer is a blocking error, never truncated. */
export const MAX_BRIEF_CHARS = 4000;


/** Collect every structural error, keeping a safe working copy for semantic checks. */
function ticketShapes(values: readonly unknown[]): { tickets: Ticket[]; errors: string[] } {
  const errors: string[] = [];
  const tickets = values.map((value, i) => {
    const index = i + 1;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push("ticket " + index + " must be an object (field: ticket)");
      return { title: "" };
    }
    const raw = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const who = "ticket " + index + (typeof raw.id === "string" ? " (\"" + raw.id + "\")" : "");
    const problem = (field: string, message: string) => errors.push(who + ": " + field + " " + message);
    for (const field of ["id", "title", "body", "agent", "effort", "role", "kind", "milestone", "sensitivity", "model"]) {
      if (raw[field] === undefined) continue;
      if (typeof raw[field] !== "string") problem(field, "must be a string");
      else out[field] = raw[field];
    }
    for (const field of ["dependsOn", "after", "files", "acceptance", "outOfScope", "decisions", "context", "locks", "needs"]) {
      const v = raw[field];
      if (v === undefined) continue;
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) problem(field, "must be an array of strings");
      else out[field] = v;
    }
    const enums: Record<string, readonly string[]> = {
      kind: ["code", "asset", "design-data", "qa", "prototype", "docs"],
      sensitivity: ["public", "internal", "secret"],
      needs: ["shell", "vision", "web", "engine", "image-gen", "audio-gen"],
    };
    for (const [field, allowed] of Object.entries(enums)) {
      const v = out[field];
      if (v !== undefined && !(Array.isArray(v) ? v : [v]).every((x) => allowed.includes(x as string))) {
        problem(field, "must use only: " + allowed.join(", "));
        delete out[field];
      }
    }
    if (typeof out.role === "string" && !/^[a-z][a-z0-9-]*$/.test(out.role)) problem("role", "must be a lowercase role slug");
    if (typeof out.milestone === "string" && !out.milestone.trim()) problem("milestone", "must be non-empty");
    for (const field of ["decisions", "context", "locks", "needs"]) {
      const v = out[field];
      if (!Array.isArray(v)) continue;
      if (new Set(v).size !== v.length) problem(field, "must contain unique values");
      if (field === "decisions" && !v.every((x) => /^D-[0-9]{3,}$/.test(x))) problem(field, "must contain D-### decision ids");
      if (field === "context" && !v.every((x) => /^[a-z0-9]+(\.[a-z0-9-]+)*$/.test(x))) problem(field, "must contain dotted context anchors");
      if (field === "locks") for (const path of v) {
        try { normalizeLockPath(path); } catch (error) { problem(field, (error as Error).message); }
      }
    }
    if (raw.kind === "asset" && (!Array.isArray(raw.locks) || !raw.locks.length)) problem("locks", "must be non-empty for kind asset");
    if (raw.verify !== undefined) {
      if (!Array.isArray(raw.verify) || !raw.verify.length || !raw.verify.every((argv) =>
        Array.isArray(argv) && argv.length > 0 && argv.every((arg) => typeof arg === "string" && arg.trim().length > 0))) {
        problem("verify", "must be a non-empty array of non-empty argv arrays of non-empty strings (no shell command strings)");
      } else out.verify = raw.verify;
    }
    if (raw.budget !== undefined) {
      const budget = raw.budget;
      if (!budget || typeof budget !== "object" || Array.isArray(budget)) problem("budget", "must be an object");
      else {
        out.budget = budget;
        for (const [key, n] of Object.entries(budget)) {
          if (!["minutes", "usd", "requests"].includes(key) || typeof n !== "number" || !Number.isFinite(n) || n < 0 || (key === "requests" && !Number.isInteger(n))) {
            problem("budget." + key, "must be a supported non-negative number (requests must be an integer)");
            delete out.budget;
          }
        }
      }
    }
    return { ...out, title: out.title ?? "" } as unknown as Ticket;
  });
  return { tickets, errors };
}

/** Parse JSON and report every structural problem together. */
export function parseTickets(raw: string): Ticket[] {
  const value: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (!Array.isArray(value)) throw new Error("tickets file must be a JSON array");
  const result = ticketShapes(value);
  if (result.errors.length) throw new Error(result.errors.join("; "));
  return result.tickets;
}

/** Parse the structured issue metadata without loading issue-creation I/O. */
export function parseTicketV2(body: string): TicketV2 {
  const json = /^## Ticket metadata \(v2\)\r?\n\r?\n```json\r?\n([\s\S]*?)\r?\n```[ \t]*$/m.exec(body)?.[1];
  if (json === undefined) return {};
  const fields: unknown = JSON.parse(json);
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("ticket metadata must be an object");
  return ticketV2Fields(parseTickets(JSON.stringify([{ ...fields, title: "metadata" }]))[0]);
}

export interface ResolvedTicket extends TicketV2 {
  /** 1-based position in the file. */
  index: number;
  id?: string;
  title: string;
  /** The human description (no rendered dep line). */
  body: string;
  files: string[];
  /** The definition of done and out-of-scope list, trimmed with empties dropped. */
  acceptance: string[];
  outOfScope: string[];
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
  design?: DesignContext;
  /** Loaded project config enables pack validation without adding IO to the validator. */
  config?: OrchConfig;
  /** Configured agents. When given, a ticket routed to any other agent is dropped (warning). */
  agents?: readonly string[];
  tierAliases?: TierAliases;
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
  opts = { agents: opts.config?.agents, tierAliases: opts.config?.tierAliases, ...opts };
  const shaped = ticketShapes(tickets);
  const errors = shaped.errors;
  const warnings: string[] = [];
  const seen = new Set<string>();
  const fileOwners = new Map<string, number[]>();
  const resolved: ResolvedTicket[] = [];

  shaped.tickets.forEach((t, i) => {
    const index = i + 1;
    const who = `ticket ${index}${t.id ? ` ("${t.id}")` : ""}`;
    if (!t.title.trim()) errors.push(`${who}: title needs a title`);
    if (t.id && seen.has(t.id)) errors.push(`${who}: id duplicate id "${t.id}"`);
    const cfg = opts.config;
    if (cfg?.pack !== undefined) {
      errors.push(...designReferenceErrors(t, opts.design).map(error => `${who}: ${error}`));
      for (const field of ["role", "kind", "verify"] as const) {
        if (!t[field]) errors.push(`${who}: ${field} is required when pack is configured`);
      }
      const role = t.role;
      if (role) {
        if (!cfg.loadedPack || !Object.hasOwn(cfg.loadedPack.roles, role)) {
          errors.push(`${who}: role '${role}' does not exist in the pack`);
        } else {
          const allowance = cfg.roles[role];
          const tier = normalizeEffort(t.effort?.trim(), cfg.tierAliases);
          if (t.effort !== undefined && (!tier || !allowance.tiers.includes(tier))) {
            errors.push(`${who}: effort '${t.effort}' is outside role '${role}' tiers`);
          }
          if (t.agent !== undefined) {
            const agent = t.agent.trim();
            const tiers = tier ? [tier] : allowance.tiers;
            if (!cfg.agents.includes(agent) || !tiers.some((tier) => {
              const family = routeFamily(agent, tier, cfg);
              return family !== undefined && allowance.families.includes(family);
            })) {
              errors.push(`${who}: agent '${agent}' has no allowed family for role '${role}'`);
            }
          }
        }
      }
    }

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

    const acceptance = (t.acceptance ?? []).map((item) => item.trim()).filter(Boolean);
    const outOfScope = (t.outOfScope ?? []).map((item) => item.trim()).filter(Boolean);
    warnings.push(...definitionOfDoneWarnings(index, { title: t.title, body: t.body, acceptance }));

    const files = t.files ?? [];
    for (const f of files) fileOwners.set(f, [...(fileOwners.get(f) ?? []), index]);

    let agent = t.agent?.trim() || undefined;
    if (agent && opts.agents && !opts.agents.includes(agent)) {
      warnings.push(`ticket ${index} is routed to unknown agent "${agent}"; dropped (the judge will route it)`);
      agent = undefined;
    }
    let effort = normalizeEffort(t.effort?.trim(), opts.tierAliases);
    if (t.effort?.trim() && !effort) {
      warnings.push(`ticket ${index} has unknown effort "${t.effort}" (use free, cheap, standard, or lead); dropped`);
      effort = undefined;
    }
    if (effort && !agent) {
      warnings.push(`ticket ${index} has an effort but no agent; dropped so the judge routes it whole`);
      effort = undefined;
    }

    if (t.id) seen.add(t.id);
    resolved.push({
      ...ticketV2Fields(t),
      index, id: t.id, title: t.title, body: (t.body ?? "").trim(), files, acceptance, outOfScope, dependsOn, knownDeps, after, knownAfter,
      ...(agent ? { agent } : {}),
      ...(effort ? { effort: effort as EffortTier } : {}),
    });
  });

  for (const [file, owners] of fileOwners) {
    if (owners.length > 1) warnings.push(`file "${file}" is claimed by tickets ${owners.join(", ")}`);
  }

  const byId = new Map(resolved.filter((t) => t.id).map((t) => [t.id!, t]));
  const depends = (from: ResolvedTicket, target: ResolvedTicket, seen = new Set<ResolvedTicket>()): boolean => {
    if (seen.has(from)) return false;
    seen.add(from);
    return from.knownDeps.some((id) => {
      const dep = byId.get(id);
      return dep !== undefined && (dep === target || depends(dep, target, seen));
    });
  };
  const who = (t: ResolvedTicket) => `ticket ${t.index}${t.id ? ` ("${t.id}")` : ""}`;
  for (let i = 0; i < resolved.length; i++) for (let j = i + 1; j < resolved.length; j++) {
    const a = resolved[i], b = resolved[j];
    if (depends(a, b) || depends(b, a)) continue;
    for (const left of a.locks ?? []) for (const right of b.locks ?? []) {
      try {
        if (lockPathsOverlap(left, right)) errors.push(`${who(a)} and ${who(b)}: locks overlap (${JSON.stringify(left)}, ${JSON.stringify(right)}); add a dependsOn path`);
      } catch { /* Structural path errors were already collected above. */ }
    }
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
