import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createIssue, listIssues, type Issue } from "../github/github.js";
import { STATUS } from "../github/labels.js";
import { parseTickets, resolvePlan, type Ticket } from "./plan.js";

const MARKER_VERSION = "v1";

export interface Created {
  id?: string;
  number: number;
  title: string;
}

export interface Failed {
  id?: string;
  title: string;
  error: string;
}

export interface PlanCreateResult {
  created: Created[];
  reused: Created[];
  failed: Failed[];
}

export interface PlanMarkers {
  plan: string;
  tickets: string[];
}

export interface TicketMarkers {
  plan: string;
  ticket: string;
}

export interface PlanCreateDeps {
  listIssues: typeof listIssues;
  createIssue: typeof createIssue;
}

const defaultDeps: PlanCreateDeps = { listIssues, createIssue };

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Return deterministic HTML comments for a semantic plan and each position in
 * it. JSON formatting and omitted-vs-empty optional fields do not affect the
 * identity; creation order does, because it changes dependency semantics.
 */
export function buildPlanMarkers(tickets: readonly Ticket[]): PlanMarkers {
  const normalized = tickets.map((ticket) => ({
    id: ticket.id ?? null,
    title: ticket.title,
    body: (ticket.body ?? "").trim(),
    dependsOn: ticket.dependsOn ?? [],
    files: ticket.files ?? [],
  }));
  const planDigest = digest(JSON.stringify(normalized));
  const plan = `<!-- orch-plan:${MARKER_VERSION}:${planDigest} -->`;
  const ticketMarkers = normalized.map((ticket, index) => {
    const identity = ticket.id === null ? `index:${index + 1}` : `id:${ticket.id}`;
    return `<!-- orch-ticket:${MARKER_VERSION}:${digest(`${planDigest}\u0000${identity}`)} -->`;
  });
  return { plan, tickets: ticketMarkers };
}

/** Pure: render the GitHub issue body from a ticket + resolved dependency numbers. */
export function renderTicketBody(
  ticket: Ticket,
  depNumbers: number[],
  markers?: TicketMarkers,
): string {
  const parts: string[] = [];
  if (ticket.body) parts.push(ticket.body.trim());
  if (ticket.files?.length) {
    parts.push(`**Files (ownership hint):** ${ticket.files.map((f) => `\`${f}\``).join(", ")}`);
  }
  if (depNumbers.length) {
    parts.push(`Depends-on: ${depNumbers.map((n) => `#${n}`).join(", ")}`);
  }
  if (markers) parts.push(`${markers.plan}\n${markers.ticket}`);
  return parts.join("\n\n") || "_(no description)_";
}

function failure(ticket: Ticket, error: unknown): Failed {
  return {
    id: ticket.id,
    title: ticket.title,
    error: error instanceof Error ? error.message : String(error),
  };
}

function indexByMarker(issues: readonly Issue[], markers: readonly string[]): Map<string, Issue[]> {
  const indexed = new Map<string, Issue[]>();
  for (const marker of markers) {
    const matches = issues.filter((issue) => issue.body.includes(marker)).sort((a, b) => a.number - b.number);
    if (matches.length) indexed.set(marker, matches);
  }
  return indexed;
}

async function discover(
  cwd: string,
  markers: readonly string[],
  deps: PlanCreateDeps,
): Promise<Map<string, Issue[]>> {
  return indexByMarker(await deps.listIssues({ cwd, state: "all" }), markers);
}

function reusedResult(ticket: Ticket, issue: Issue): Created {
  return { id: ticket.id, number: issue.number, title: ticket.title };
}

/**
 * Create a plan as a resumable roll-forward operation.
 *
 * Every issue carries deterministic plan/ticket markers. Existing markers are
 * discovered before any write, and a failed create is reconciled with a fresh
 * discovery before it is reported as failed. The function never retries an
 * ambiguous create blindly: a later invocation either reuses the issue GitHub
 * did create or safely creates the still-missing ticket.
 */
export async function createFromPlan(
  tickets: readonly Ticket[],
  cwd: string,
  deps: PlanCreateDeps = defaultDeps,
): Promise<PlanCreateResult> {
  const plan = resolvePlan(tickets);
  if (plan.errors.length) throw new Error(`invalid tickets: ${plan.errors.join("; ")}`);

  const result: PlanCreateResult = { created: [], reused: [], failed: [] };
  if (!tickets.length) return result;

  const markers = buildPlanMarkers(tickets);
  let existing: Map<string, Issue[]>;
  try {
    existing = await discover(cwd, markers.tickets, deps);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    result.failed.push(...tickets.map((ticket) => failure(ticket, `discovery failed: ${detail}`)));
    return result;
  }

  const idToNumber = new Map<string, number>();
  for (let index = 0; index < tickets.length; index++) {
    const ticket = tickets[index];
    const marker = markers.tickets[index];
    const matches = existing.get(marker) ?? [];
    if (matches.length > 1) {
      result.failed.push(
        failure(ticket, `ticket marker matches multiple issues: ${matches.map((issue) => `#${issue.number}`).join(", ")}`),
      );
      continue;
    }
    if (matches.length === 1) {
      const reused = reusedResult(ticket, matches[0]);
      result.reused.push(reused);
      if (ticket.id) idToNumber.set(ticket.id, reused.number);
      continue;
    }

    const missingDeps = plan.tickets[index].knownDeps.filter((id) => !idToNumber.has(id));
    if (missingDeps.length) {
      result.failed.push(failure(ticket, `dependency ticket(s) unavailable: ${missingDeps.join(", ")}`));
      continue;
    }

    const depNumbers = plan.tickets[index].knownDeps.map((id) => idToNumber.get(id) as number);
    const body = renderTicketBody(ticket, depNumbers, { plan: markers.plan, ticket: marker });
    try {
      const number = await deps.createIssue(ticket.title, body, [STATUS.todo], { cwd });
      const created = { id: ticket.id, number, title: ticket.title };
      result.created.push(created);
      if (ticket.id) idToNumber.set(ticket.id, number);
    } catch (createError) {
      // The request may have committed even though gh returned an error or its
      // response was lost. Re-observe before deciding whether this ticket failed.
      try {
        existing = await discover(cwd, markers.tickets, deps);
      } catch (discoverError) {
        const createDetail = createError instanceof Error ? createError.message : String(createError);
        const discoverDetail = discoverError instanceof Error ? discoverError.message : String(discoverError);
        result.failed.push(failure(ticket, `${createDetail}; reconciliation failed: ${discoverDetail}`));
        continue;
      }

      const reconciled = existing.get(marker) ?? [];
      if (reconciled.length === 1) {
        const reused = reusedResult(ticket, reconciled[0]);
        result.reused.push(reused);
        if (ticket.id) idToNumber.set(ticket.id, reused.number);
      } else if (reconciled.length > 1) {
        result.failed.push(
          failure(
            ticket,
            `ticket marker matches multiple issues after create: ${reconciled
              .map((issue) => `#${issue.number}`)
              .join(", ")}`,
          ),
        );
      } else {
        result.failed.push(failure(ticket, createError));
      }
    }
  }
  return result;
}

/** Read a JSON tickets file and create or reuse its issues. */
export function planFromFile(file: string, cwd: string): Promise<PlanCreateResult> {
  return createFromPlan(parseTickets(readFileSync(file, "utf8")), cwd);
}
