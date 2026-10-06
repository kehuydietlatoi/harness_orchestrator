import { lastFencedBlock } from "../adapters/headless.js";
import { parseReview, reviewNotes } from "../board/approval.js";
import type { ChangedFile } from "../board/review-run.js";
import type { Issue, IssueComment, Pr, PrReview } from "../github/github.js";

/**
 * Lead triage (ADR-0010): when a task has spent its round budget, the lead reads the task and
 * decides, once, whether one more guided round can finish it or a human must decide. This
 * module is pure: the durable record, its parser, the facts derived from it, the decision
 * contract, and the prompt. The executor lives in `step-exec.ts`.
 *
 * The record is a PR conversation comment ending in an `orch-triage:v1` marker, like the
 * review record, so the decision survives a crash and the loop re-derives it from GitHub.
 * Free text (guidance, diagnosis) stays outside the marker: JSON inside an HTML comment
 * must never carry text that could close it.
 */

export interface TriageRecord {
  pr: number;
  /** The head the lead read. */
  head: string;
  timestamp: string;
  decision: "retry" | "escalate";
  /** Fix rounds this decision granted: 1 for a retry, 0 for an escalation. */
  extraRounds: 0 | 1;
  /** Set when the retry also moved the task to the hard tier. */
  effort?: "hard";
}

const MARKER = /\n<!-- orch-triage:v1 (.+) -->\s*$/;
const GUIDANCE_HEADING = "### Guidance for the author";

/** The lead's verdict, parsed from its fenced JSON reply. */
export type TriageDecision =
  | { decision: "retry"; guidance: string; effort?: "hard" }
  | { decision: "escalate"; diagnosis: string; question?: string };

/** Render the PR comment that records a triage. Guidance, when present, is always the last section. Pure. */
export function formatTriageComment(record: TriageRecord, params: { issue: number; reason: string; text: string }): string {
  const what = record.decision === "retry"
    ? `one more fix round${record.effort === "hard" ? ", on the hard model tier" : ""}`
    : "a human needs to decide (see the escalation comment)";
  const body = record.decision === "retry"
    ? `${GUIDANCE_HEADING}\n\n${params.text.trim()}`
    : `### Diagnosis\n\n${params.text.trim()}`;
  return [
    `**orch lead triage on #${params.issue}.** The round budget was spent: ${params.reason}.`,
    "",
    `Decision: ${what}.`,
    "",
    body,
    "",
    `<!-- orch-triage:v1 ${JSON.stringify(record)} -->`,
  ].join("\n");
}

/** Read a complete triage record (and the comment's text) from a PR comment, or null. Pure. */
export function parseTriageComment(comment: Pick<IssueComment, "body">): { record: TriageRecord; text: string } | null {
  const match = comment.body.match(MARKER);
  if (!match) return null;
  try {
    const r = JSON.parse(match[1]) as TriageRecord;
    const valid =
      Number.isSafeInteger(r.pr) && r.pr > 0 &&
      typeof r.head === "string" && /^[a-f0-9]{40,64}$/.test(r.head) &&
      typeof r.timestamp === "string" && Number.isFinite(Date.parse(r.timestamp)) &&
      ((r.decision === "retry" && r.extraRounds === 1) || (r.decision === "escalate" && r.extraRounds === 0)) &&
      (r.effort === undefined || r.effort === "hard");
    return valid ? { record: r, text: comment.body.replace(MARKER, "").trim() } : null;
  } catch {
    return null;
  }
}

export interface TriageFacts {
  /** Triage records on this PR. */
  triages: number;
  /** Fix rounds granted by them, capped at `maxTriages` (each real triage grants at most one). */
  extraRounds: number;
  /** The newest retry's guidance for the author, or null. */
  guidance: string | null;
}

/** Derive triage facts for one PR from its comments. Pure. */
export function triageFacts(comments: readonly Pick<IssueComment, "id" | "body">[], pr: number, maxTriages: number): TriageFacts {
  let triages = 0;
  let granted = 0;
  let guidance: string | null = null;
  for (const comment of [...comments].sort((a, b) => a.id - b.id)) {
    const parsed = parseTriageComment(comment);
    if (!parsed || parsed.record.pr !== pr) continue;
    triages += 1;
    granted += parsed.record.extraRounds;
    if (parsed.record.decision === "retry") {
      const at = parsed.text.indexOf(GUIDANCE_HEADING);
      guidance = at >= 0 ? parsed.text.slice(at + GUIDANCE_HEADING.length).trim() || null : null;
    }
  }
  return { triages, extraRounds: Math.min(granted, Math.max(0, maxTriages)), guidance };
}

/** Parse the lead's reply. Anything but one well-formed decision is null (fail-closed: the task escalates). Pure. */
export function parseTriageDecision(text: string): TriageDecision | null {
  const block = lastFencedBlock(text);
  if (block === null) return null;
  try {
    const v = JSON.parse(block) as Record<string, unknown>;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    if (v.decision === "retry") {
      if (typeof v.guidance !== "string" || !v.guidance.trim()) return null;
      if (v.effort !== undefined && v.effort !== "hard") return null;
      return { decision: "retry", guidance: v.guidance.trim(), ...(v.effort === "hard" ? { effort: "hard" as const } : {}) };
    }
    if (v.decision === "escalate") {
      if (typeof v.diagnosis !== "string" || !v.diagnosis.trim()) return null;
      if (v.question !== undefined && typeof v.question !== "string") return null;
      const question = typeof v.question === "string" && v.question.trim() ? v.question.trim() : undefined;
      return { decision: "escalate", diagnosis: v.diagnosis.trim(), ...(question ? { question } : {}) };
    }
    return null;
  } catch {
    return null;
  }
}

function reviewHistory(reviews: readonly PrReview[], pr: number): string[] {
  const lines: string[] = [];
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    const r = parseReview(review);
    if (!r || r.pr !== pr) continue;
    const verdict = r.decision === "approve" ? "approved" : "requested changes";
    lines.push(`- ${r.reviewer}${r.mode === "self" ? " (self)" : ""} ${verdict} on ${r.head.slice(0, 8)}:`);
    lines.push(...(reviewNotes(review) || "(no notes)").split(/\r?\n/).map((line) => `    ${line}`));
  }
  return lines.length ? lines : ["(no recorded reviews)"];
}

/** The read-only lead prompt for one stuck task. Pure. */
export function formatTriagePrompt(params: {
  issue: Pick<Issue, "number" | "title" | "body">;
  pr: Pick<Pr, "number" | "headSha" | "headRefName">;
  author: string;
  effort: "easy" | "hard" | null;
  reason: string;
  checks: string;
  mergeable: string;
  reviews: readonly PrReview[];
  files: readonly ChangedFile[];
}): string {
  const { issue, pr, author, effort, reason, checks, mergeable, reviews, files } = params;
  const changed = files.length
    ? files.map((f) => `- ${f.path} (${f.status}${f.binary ? ", binary" : `, +${f.additions}/-${f.deletions}`})`)
    : ["(the changed files could not be listed; inspect the checkout)"];
  return [
    `# Lead triage: task #${issue.number}: ${issue.title}`,
    "",
    "You are the lead engineer. orch's autonomous loop could not finish this task within its fix-round budget,",
    "and you decide, once, what happens next. Your working directory is a read-only checkout of the pull",
    `request head (${pr.headSha}); read whatever you need. Do not edit files, run commands that change state,`,
    "or spawn sub-agents or parallel workers: read, decide, and answer.",
    "",
    "## Why the loop stopped",
    reason,
    "",
    `## Pull request #${pr.number} (${pr.headRefName}) by ${author}${effort ? ` on the ${effort} tier` : ""}`,
    `CI: ${checks}. Mergeable: ${mergeable}.`,
    "",
    "## Review history (oldest first)",
    ...reviewHistory(reviews, pr.number),
    "",
    "## Changed files",
    ...changed,
    "",
    "## Spec (the issue; may include the plan's context)",
    issue.body.trim() || "_(no description)_",
    "",
    "## Decide",
    "- **retry**: one more round by the author can finish it. Give concrete guidance: what to change, what in the feedback",
    "  is out of scope or wrong and can be declined with a short reason, and how to verify. Add `\"effort\": \"hard\"` only if",
    "  the task is on the easy tier and the failures look like the model is out of its depth.",
    "- **escalate**: a human must decide (ambiguous or contradictory spec, reviewer and author disagree on scope, a design",
    "  problem, flaky CI or infrastructure, or rounds that keep regressing). Diagnose it and ask the one question the human",
    "  must answer.",
    "",
    "Reply with exactly one fenced code block tagged json and nothing after it, one of:",
    "```json",
    '{ "decision": "retry", "guidance": "...", "effort": "hard" }',
    "```",
    "(omit `effort` to keep the tier) or",
    "```json",
    '{ "decision": "escalate", "diagnosis": "...", "question": "..." }',
    "```",
    "",
  ].join("\n");
}
