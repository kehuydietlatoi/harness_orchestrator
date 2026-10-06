import type { Ticket } from "../tasks/plan.js";
import type { PlanCreateOptions, PlanCreateResult } from "../tasks/plan-create.js";
import type { AutoRouteResult } from "./assign.js";

/**
 * The one human gate between planning and autonomous execution. After the plan
 * preview, orch either runs the whole pipeline (create, route, autopilot), asks
 * once, or only prints the next commands:
 *
 * - `run`  — `--yes` was given: the operator approved up front.
 * - `ask`  — an interactive planning session on a terminal: confirm once.
 * - `hint` — anything else (no terminal, or a tickets file without `--yes`).
 */
export type PlanGate = "run" | "ask" | "hint";

/** Decide the gate. Pure. */
export function planGate(opts: { yes?: boolean; interactive: boolean; tty: boolean }): PlanGate {
  if (opts.yes) return "run";
  if (opts.interactive && opts.tty) return "ask";
  return "hint";
}

/** Everything the pipeline does to the world, injected so the flow is testable without GitHub or agents. */
export interface PipelineDeps {
  create(tickets: readonly Ticket[], opts: PlanCreateOptions): Promise<PlanCreateResult>;
  /** Print the create result (created / reused / failed). */
  report(result: PlanCreateResult): void;
  /** Route the still-unrouted issues among `only` with the judge; throws (writing nothing) when it fails. */
  route(only: ReadonlySet<number>): Promise<AutoRouteResult>;
  /** Run the autopilot scoped to these issues until the plan is complete or it stops. */
  autopilot(issues: readonly number[]): Promise<void>;
  say(line: string): void;
}

export interface PipelineInput {
  tickets: readonly Ticket[];
  brief?: string;
  agents: readonly string[];
  /** Start the autopilot after routing (`--no-run` stops after routing). */
  run: boolean;
}

export interface PipelineResult {
  /** The plan's issues (created and reused), ascending. */
  issues: number[];
  stage: "create-failed" | "route-failed" | "routed" | "ran";
}

/**
 * Create the plan's issues, route whatever the plan left unrouted, then hand the
 * plan to a scoped autopilot. Each stage stops the pipeline on failure, so nothing
 * runs on a half-created or unrouted plan, and every stop prints the command that
 * resumes it: creation is idempotent, routing is fill-blanks-only, and the autopilot
 * re-derives everything from GitHub.
 */
export async function runPlanPipeline(input: PipelineInput, deps: PipelineDeps): Promise<PipelineResult> {
  const created = await deps.create(input.tickets, { agents: input.agents, brief: input.brief });
  deps.report(created);
  const issues = [...created.created, ...created.reused].map((i) => i.number).sort((a, b) => a - b);
  if (created.failed.length) {
    deps.say("Not starting: some issues could not be created. Re-run the same command; creation is resumable.");
    return { issues, stage: "create-failed" };
  }
  if (issues.length === 0) {
    deps.say("The plan has no tickets; nothing to run.");
    return { issues, stage: "routed" };
  }

  const resume = `orch autopilot --issues ${issues.join(",")}`;
  try {
    const routed = await deps.route(new Set(issues));
    if (routed.unrouted > 0) {
      deps.say(`Routed ${routed.written} of ${routed.unrouted} unrouted issue(s) with the judge.`);
      if (routed.written < routed.unrouted) {
        deps.say("Unrouted issues are never claimed; route them with `orch assign` and the run picks them up.");
      }
    }
  } catch (error) {
    deps.say(`Routing failed, nothing started: ${error instanceof Error ? error.message : String(error)}`);
    deps.say(`Route with \`orch assign --auto\`, then start with \`${resume}\`.`);
    return { issues, stage: "route-failed" };
  }

  if (!input.run) {
    deps.say(`Created and routed. Start with: ${resume}`);
    return { issues, stage: "routed" };
  }
  deps.say(`Starting autopilot for ${issues.map((n) => `#${n}`).join(", ")}. If interrupted, resume with: ${resume}`);
  await deps.autopilot(issues);
  return { issues, stage: "ran" };
}
