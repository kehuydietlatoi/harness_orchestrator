import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectStateDir } from "../board/telemetry.js";
import { log } from "../util/log.js";

/**
 * The loop's append-only signal log (`~/.orch/<project>/events.jsonl`). Every step the
 * coordinator starts or finishes lands here, so the file is both an audit trail and the
 * raw material for evaluation (rounds to approval, cost per merged task, escalation rate).
 * It is advisory: decisions are always re-derived from GitHub/Git facts, never from this log,
 * so losing or truncating it can only blur the statistics and the round count - never
 * corrupt a task.
 */
export interface OrchEvent {
  ts: string;
  issue: number;
  /** `task.started`, `step.started`, `step.finished`, `task.merged`, `task.escalated`, ... */
  type: string;
  step?: string;
  /** Outcome signal of a finished step (`review.approved`, `fix.pushed`, ...). */
  signal?: string;
  pr?: number;
  agent?: string;
  detail?: string;
  durationMs?: number;
}

export function eventsPath(cwd: string): string {
  return join(projectStateDir(cwd), "events.jsonl");
}

/** Best-effort append; telemetry must never change a task's outcome. */
export function appendEvent(event: Omit<OrchEvent, "ts">, cwd: string, now: Date = new Date()): void {
  try {
    const path = eventsPath(cwd);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ ts: now.toISOString(), ...event })}\n`, "utf8");
  } catch (error) {
    log.warn(`could not append event: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function readEvents(cwd: string): OrchEvent[] {
  let text: string;
  try {
    text = readFileSync(eventsPath(cwd), "utf8");
  } catch {
    return [];
  }
  const events: OrchEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Partial<OrchEvent>;
      if (typeof e.ts === "string" && Number.isInteger(e.issue) && typeof e.type === "string") events.push(e as OrchEvent);
    } catch {
      // a torn or malformed line is skipped, never fatal
    }
  }
  return events;
}

const ROUND_SIGNALS: ReadonlySet<string> = new Set(["fix.pushed", "conflict.resolved"]);

/**
 * Fix/conflict rounds already pushed for `issue` since it was last (re)started. A new
 * `task.started` (re-claim after abandon) resets the count so an old attempt cannot
 * spend the new one's budget.
 */
export function fixRoundsFor(events: readonly OrchEvent[], issue: number): number {
  let rounds = 0;
  for (const e of events) {
    if (e.issue !== issue) continue;
    if (e.type === "task.started") rounds = 0;
    else if (e.type === "step.finished" && e.signal && ROUND_SIGNALS.has(e.signal)) rounds += 1;
  }
  return rounds;
}
