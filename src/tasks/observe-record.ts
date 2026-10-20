import type { IssueComment } from "../github/github.js";
import { parseObserveVerdict, type ObserveVerdict } from "./observe-judge.js";
import type { StepFacts } from "./steps.js";

export interface ObserveRecord extends Omit<ObserveVerdict, "gate"> {
  pr: number;
  evidenceError?: string;
}

export function formatObserveComment(record: ObserveRecord, paths: readonly string[]): string {
  const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
  return [
    `**orch observe: ${record.overall}** (${record.sha})`, "",
    "| Acceptance | Verdict | Evidence | Note |", "| --- | --- | --- | --- |",
    ...record.lines.map(l => `| ${[l.acceptance, l.verdict, l.evidence.join(", "), l.note].map(cell).join(" | ")} |`),
    "", ...record.concerns, record.evidenceError ?? "", "", "Evidence folders:", ...paths.map(p => `- ${p}`), "",
    // Escape HTML delimiters even when free text contains a comment terminator.
    `<!-- orch-observe:v1 ${JSON.stringify(record).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")} -->`,
  ].join("\n");
}

export function newestObserveRecord(comments: readonly IssueComment[], pr: number, sha: string): ObserveRecord | null {
  return newestObserveEntry(comments, pr, sha)?.record ?? null;
}

/** Keep GitHub's write time beside the record without changing the persisted marker. */
export function newestObserveEntry(comments: readonly IssueComment[], pr: number, sha: string): { record: ObserveRecord; createdAt: string } | null {
  for (const c of [...comments].sort((a, b) => b.id - a.id)) {
    const match = c.body.match(/<!-- orch-observe:v1 (.+) -->\s*$/);
    if (!match) continue;
    try {
      const r = JSON.parse(match[1]) as ObserveRecord;
      if (r.pr !== pr || r.sha !== sha || (r.evidenceError !== undefined && typeof r.evidenceError !== "string")) continue;
      const verdict = parseObserveVerdict("```json\n" + JSON.stringify({ ...r, gate: "observe" }) + "\n```", sha);
      if (!("kind" in verdict)) return { record: r, createdAt: c.created_at };
    } catch { /* Malformed records grant nothing. */ }
  }
  return null;
}

export function observeRecordFact(status: string | null, record: ObserveRecord | null,
  handback?: { recordedAt: string; removedAt: string | null }): NonNullable<StepFacts["observe"]> {
  let state: NonNullable<StepFacts["observe"]>["state"] = !status || !record ? "missing"
    : status === "success" && record.overall === "verified" ? "verified"
    : status === "failure" && record.overall === "not-verified" && !record.evidenceError ? "not-verified"
    : "blocked";
  if (state === "blocked" && handback?.removedAt && Date.parse(handback.removedAt) > Date.parse(handback.recordedAt)) {
    state = "missing";
  }
  return { required: true, state };
}

export function observeFeedback(record: ObserveRecord): string {
  return [record.evidenceError ?? "", ...record.concerns,
    ...record.lines.filter(l => l.verdict !== "verified").map(l => `${l.acceptance}: ${l.verdict}\n${l.note}\nEvidence: ${l.evidence.join(", ")}`),
  ].filter(Boolean).join("\n\n");
}
