import { lastFencedBlock } from "../adapters/headless.js";
import type { RunReport } from "../board/report.js";
import { formatRunReport } from "../board/report.js";
import { parseTickets, resolvePlan, type Ticket } from "./plan.js";

/**
 * The lead's end-of-run summary (ADR-0010): a short narrative over the run report, plus any
 * follow-up work it noticed (deferred feedback, escalations that need a new ticket) as a
 * tickets draft. The draft is only ever written to a file for the operator to review with
 * `orch plan`; nothing here creates issues, so the one human gate stays the only way in.
 */

export interface SummaryTask {
  issue: number;
  title: string;
  outcome: string;
  /** Why the loop escalated it, when it did. */
  escalation?: string;
}

/** Build the read-only lead prompt. Pure. */
export function formatSummaryPrompt(report: RunReport, tasks: readonly SummaryTask[]): string {
  const lines = tasks.map((t) => `- #${t.issue} ${t.title}: ${t.outcome}${t.escalation ? ` (escalated: ${t.escalation})` : ""}`);
  return [
    "# Autopilot run summary",
    "",
    "You are the lead engineer. orch's autonomous loop just finished a run. Your working directory is the",
    "repository (read-only: do not edit files or spawn sub-agents). Summarise the run for the operator and",
    "propose follow-up work.",
    "",
    "## Run report",
    formatRunReport(report),
    "",
    "## Tasks",
    ...(lines.length ? lines : ["(none)"]),
    "",
    "## Reply",
    "1. A short markdown summary (at most 15 lines): what landed, what is stuck and why, what the numbers say",
    "   (rounds to approval, escalations, cost), and the one thing the operator should do next.",
    "2. Then exactly one fenced code block tagged json: an array of follow-up tickets in the orch-plan schema",
    '   ({ "id", "title", "body", "dependsOn", "files", "agent", "effort" }), only for concrete work the run',
    "   revealed (an escalation that needs a new ticket, feedback deferred as out of scope). Use [] when there is none.",
    "",
  ].join("\n");
}

export interface ParsedSummary {
  narrative: string;
  /** Valid follow-up tickets ([] when none); null when the block was missing or invalid. */
  tickets: Ticket[] | null;
  /** Why `tickets` is null. */
  problem?: string;
}

/** Split the lead's reply into the narrative and a validated follow-up draft. Pure. */
export function parseSummary(text: string): ParsedSummary {
  const block = lastFencedBlock(text);
  const narrative = text.replace(/```(?:json)?\s*[\s\S]*?```/gi, "").trim();
  if (block === null) return { narrative, tickets: null, problem: "no follow-up block" };
  try {
    const tickets = parseTickets(block);
    const { errors } = resolvePlan(tickets);
    if (errors.length) return { narrative, tickets: null, problem: errors.join("; ") };
    return { narrative, tickets };
  } catch (error) {
    return { narrative, tickets: null, problem: error instanceof Error ? error.message : String(error) };
  }
}
