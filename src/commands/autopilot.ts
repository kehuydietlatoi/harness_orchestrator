import pc from "picocolors";
import { eligibleIssues, issueAgent } from "../board/board.js";
import { buildRunReport, formatRunReport } from "../board/report.js";
import { readRuns } from "../board/telemetry.js";
import { readEvents } from "../tasks/events.js";
import { loadConfig } from "../config.js";
import { defaultDeps, runAutopilot } from "../tasks/coordinator.js";
import { observeTasks } from "../tasks/observe.js";
import type { Step } from "../tasks/steps.js";

function positive(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number (got '${value}')`);
  return n;
}

/** Parse `--issues 12,13,#14` into a scope. Throws on anything that is not a positive issue number. */
export function parseIssueList(value: string): Set<number> {
  const out = new Set<number>();
  for (const part of value.split(/[\s,]+/).filter(Boolean)) {
    const n = Number(part.replace(/^#/, ""));
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--issues must be a list of issue numbers (got '${part}')`);
    out.add(n);
  }
  if (out.size === 0) throw new Error("--issues needs at least one issue number");
  return out;
}

function formatIssues(numbers: Iterable<number>): string {
  return [...numbers].map((n) => `#${n}`).join(", ");
}

function describeStep(step: Step): string {
  switch (step.kind) {
    case "fix": return `fix (${step.reason})`;
    case "none": case "wait": case "await-human": case "triage": case "escalate": return `${step.kind}: ${step.reason}`;
    default: return step.kind;
  }
}

export async function autopilotCommand(opts: {
  max?: string;
  poll?: string;
  maxIdle?: string;
  dryRun?: boolean;
  /** Commander sets this to false for `--no-claim`. */
  claim?: boolean;
  /** Scope the run to these issues (`12,13,14`), e.g. the tickets of one plan. */
  issues?: string;
}): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  const scope = opts.issues === undefined ? undefined : parseIssueList(opts.issues);

  if (opts.dryRun) {
    const { tasks, unobserved, ambiguous } = await observeTasks(cfg, cwd, { issues: scope });
    if (scope) console.log(pc.dim(`scoped to ${formatIssues(scope)}`));
    console.log(pc.bold(`orch autopilot --dry-run — ${tasks.length} open task PR(s)\n`));
    if (!tasks.length) console.log(pc.dim("  (no open task PRs; autopilot would claim new work instead)"));
    for (const t of tasks) {
      console.log(`  #${t.issue.number} PR #${t.pr.number} by ${t.author}: ${pc.cyan(describeStep(t.step))}` +
        pc.dim(`  [round ${t.facts.rounds}/${t.facts.maxRounds}]`));
    }
    if (ambiguous.length) {
      console.log(pc.yellow(`  ambiguous (several open PRs for one issue, left alone): ${ambiguous.map((a) => `#${a.issue} (PRs ${a.prs.map((p) => `#${p}`).join(", ")})`).join("; ")}`));
    }
    if (unobserved.length) {
      console.log(pc.yellow(`  could not observe PR(s): ${unobserved.map((n) => `#${n}`).join(", ")} (autopilot would keep retrying)`));
    }
    // Say what it would start, and what it would leave alone, so nothing is claimed by surprise.
    const eligible = (await eligibleIssues(cwd)).filter((i) => !scope || scope.has(i.number));
    const routed = eligible.filter((i) => cfg.agents.includes(issueAgent(i) ?? ""));
    const unrouted = eligible.filter((i) => !issueAgent(i));
    console.log("");
    console.log(
      opts.claim === false
        ? pc.dim("  --no-claim: would not start any new task")
        : `  would claim (routed): ${routed.map((i) => `#${i.number} (${issueAgent(i)})`).join(", ") || "none"}`,
    );
    if (unrouted.length) {
      console.log(pc.dim(`  skipped (no agent: label; route with orch assign): ${unrouted.map((i) => `#${i.number}`).join(", ")}`));
    }
    return;
  }

  const max = Math.floor(positive("--max", opts.max, cfg.maxConcurrent ?? 1));
  const pollMs = Math.round(positive("--poll", opts.poll, 20) * 1000);
  const maxIdleMs = Math.round(positive("--max-idle", opts.maxIdle, 30) * 60_000);

  console.log(
    pc.bold("orch autopilot") +
      pc.dim(
        ` — up to ${max} concurrent, polling every ${pollMs / 1000}s, ${cfg.maxReviewRounds} fix round(s) per task` +
          (cfg.requireHumanMerge ? ", human merges" : ", auto-merge") +
          (cfg.maxLeadTriage > 0 ? `, lead triage before escalating (${cfg.maxLeadTriage})` : "") +
          (opts.claim === false ? ", no new tasks" : ", claims only issues with an agent: label") +
          (scope ? `, scoped to ${formatIssues(scope)}` : ""),
      ),
  );

  const startedAt = new Date();
  const controller = new AbortController();
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    controller.abort();
    console.log(pc.yellow("\nStopping after in-flight steps finish (Ctrl-C again to exit now)."));
  });

  const summary = await runAutopilot(
    { max, pollMs, maxIdleMs, signal: controller.signal, claim: opts.claim === false ? "none" : "routed", issues: scope },
    defaultDeps(cfg, cwd, scope),
  );

  console.log("");
  console.log(pc.bold(summary.stopped === "plan-complete" ? "Autopilot stopped: plan complete." : `Autopilot stopped (${summary.stopped}).`));
  console.log(`  merged:    ${summary.merged.map((n) => `#${n}`).join(", ") || "none"}`);
  console.log(`  submitted: ${summary.submitted.map((n) => `#${n}`).join(", ") || "none"}`);
  if (summary.awaitingHuman.length) {
    console.log(pc.yellow(`  awaiting your merge: ${summary.awaitingHuman.map((n) => `#${n}`).join(", ")}  (orch merge <pr> --human)`));
  }
  if (summary.ambiguous.length) {
    console.log(pc.yellow(`  ambiguous (several open PRs for one issue): ${summary.ambiguous.map((n) => `#${n}`).join(", ")}  (left alone)`));
  }
  if (summary.escalationFailed.length) {
    console.log(pc.red(`  COULD NOT ESCALATE (writes kept failing): ${summary.escalationFailed.map((n) => `#${n}`).join(", ")}  (needs you, unlabelled)`));
  }
  if (summary.triaged.length) {
    console.log(`  triaged:   ${formatIssues(summary.triaged)}  (the lead granted one more guided round)`);
  }
  if (summary.escalated.length) {
    console.log(pc.red(`  escalated to you:    ${summary.escalated.map((n) => `#${n}`).join(", ")}  (needs-attention)`));
  }
  if (summary.remaining?.length) {
    console.log(pc.yellow(`  still open:  ${formatIssues(summary.remaining)}  (blocked, unrouted, or awaiting a merge; see orch board)`));
  } else if (summary.remaining === null) {
    console.log(pc.yellow("  could not check which of the scoped issues are still open (see orch board)"));
  }
  if (summary.failures) console.log(pc.dim(`  ${summary.failures} step failure(s) along the way`));

  // What this run did and cost, from the same telemetry `orch report` reads.
  const report = buildRunReport(readEvents(cwd), readRuns(cwd), { since: startedAt, issues: scope });
  if (report.tasks.length) {
    console.log("");
    console.log(pc.bold("Run report"));
    console.log(formatRunReport(report));
    console.log(pc.dim(`  (\`orch report --since ${startedAt.toISOString()}${scope ? ` --issues ${[...scope].join(",")}` : ""} --summarize\` for the lead's summary and follow-ups)`));
  }
}
