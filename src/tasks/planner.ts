import { readFileSync } from "node:fs";
import type { OrchConfig } from "../config.js";
import {
  lastFencedBlock,
  runHeadlessAgent,
  truncate,
  type HeadlessResult,
} from "../adapters/headless.js";
import { parseTickets, resolvePlan, type Ticket } from "./plan.js";

/**
 * The planner: LLM-as-planner. It decomposes a high-level goal into a
 * `tickets.json` draft, reusing the judge's exact discipline — the same headless
 * spawn boundary (`runHeadlessAgent`), fenced-json extraction, and fail-closed
 * wrapper. The planning *contract* lives in the `orch-plan` skill so it is the one
 * source of truth for both this headless path and an interactive `/orch-plan`.
 */

/** A short, explicit output reminder appended after the skill — belt-and-suspenders
 * so the reply is a parseable ticket array even if a customised skill drifts. */
const OUTPUT_REMINDER = [
  "Output ONLY one fenced code block tagged json and nothing after it — a JSON array",
  "of ticket objects. Each ticket:",
  '  { "id": "short-slug", "title": "…", "body": "…",',
  '    "dependsOn": ["earlier-id", …], "files": ["path/hint", …] }',
  "- `title` is required; the others are optional.",
  "- `dependsOn` may only reference the `id` of an EARLIER ticket in the array.",
  "- `files` are ownership hints that minimise overlap between tickets.",
  "- Prefer small, independently-shippable tickets ordered so dependencies come first.",
].join("\n");

/** Load the canonical planning skill shipped with orch (the single source of the
 * ticket contract; `orch init` installs a copy as an interactive `/orch-plan`). */
export function loadPlanSkill(): string {
  return readFileSync(new URL("../../assets/skills/orch-plan/SKILL.md", import.meta.url), "utf8");
}

/** Build the planner prompt from the skill, the goal, and optional repo context. Pure. */
export function formatPlanPrompt(skill: string, goal: string, context = ""): string {
  const parts = [skill.trim(), "", "=== GOAL ===", goal.trim(), "=== END GOAL ==="];
  if (context.trim()) parts.push("", "=== REPO CONTEXT ===", context.trim(), "=== END CONTEXT ===");
  parts.push("", OUTPUT_REMINDER);
  return parts.join("\n");
}

/** Extract a ticket draft from the planner's reply. Throws (fail-closed upstream)
 * when there is no fenced json block or it is not a JSON array of ticket objects. Pure. */
export function extractTickets(resultText: string): Ticket[] {
  const block = lastFencedBlock(resultText);
  if (block === null) throw new Error("no fenced ```json block found");
  return parseTickets(block);
}

/** Result of one headless planner invocation. */
export type PlannerRun = HeadlessResult;

/** The spawn boundary — injectable so tests never launch a real `claude`. */
export type PlannerRunner = (
  prompt: string,
  model: string | undefined,
  cfg: OrchConfig,
  cwd: string,
) => Promise<PlannerRun>;

const defaultRunner: PlannerRunner = (prompt, model, cfg, cwd) =>
  runHeadlessAgent(prompt, model, cfg, cwd, "plan");

/**
 * Draft a ticket list from a goal, headlessly at the lead's `hard` model.
 * Fail-closed: a non-zero exit, timeout, empty/unparseable reply, an empty draft,
 * or a draft with blocking validation errors all throw — the caller creates nothing.
 */
export async function runPlanner(
  goal: string,
  skill: string,
  context: string,
  cfg: OrchConfig,
  cwd: string,
  runner: PlannerRunner = defaultRunner,
): Promise<Ticket[]> {
  const model = cfg.adapters[cfg.lead]?.models?.hard;
  const res = await runner(formatPlanPrompt(skill, goal, context), model, cfg, cwd);

  if (res.timedOut) throw new Error(`planner timed out after ${cfg.taskTimeoutMs}ms`);
  if (res.code !== 0) throw new Error(`planner exited ${res.code}\n--- output ---\n${truncate(res.raw)}`);

  const source = res.text || res.raw;
  let tickets: Ticket[];
  try {
    tickets = extractTickets(source);
  } catch (e) {
    throw new Error(`planner output not parseable: ${(e as Error).message}\n--- output ---\n${truncate(source)}`);
  }
  if (tickets.length === 0) throw new Error(`planner produced no tickets\n--- output ---\n${truncate(source)}`);

  const { errors } = resolvePlan(tickets);
  if (errors.length) throw new Error(`planner produced invalid tickets: ${errors.join("; ")}`);
  return tickets;
}
