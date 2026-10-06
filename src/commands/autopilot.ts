import pc from "picocolors";
import { eligibleIssues, issueAgent } from "../board/board.js";
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

function describeStep(step: Step): string {
  switch (step.kind) {
    case "fix": return `fix (${step.reason})`;
    case "none": case "wait": case "await-human": case "escalate": return `${step.kind}: ${step.reason}`;
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
}): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);

  if (opts.dryRun) {
    const { tasks, unobserved, ambiguous } = await observeTasks(cfg, cwd);
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
    const eligible = await eligibleIssues(cwd);
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
          (opts.claim === false ? ", no new tasks" : ", claims only issues with an agent: label"),
      ),
  );

  const controller = new AbortController();
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    controller.abort();
    console.log(pc.yellow("\nStopping after in-flight steps finish (Ctrl-C again to exit now)."));
  });

  const summary = await runAutopilot(
    { max, pollMs, maxIdleMs, signal: controller.signal, claim: opts.claim === false ? "none" : "routed" },
    defaultDeps(cfg, cwd),
  );

  console.log("");
  console.log(pc.bold(`Autopilot stopped (${summary.stopped}).`));
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
  if (summary.escalated.length) {
    console.log(pc.red(`  escalated to you:    ${summary.escalated.map((n) => `#${n}`).join(", ")}  (needs-attention)`));
  }
  if (summary.failures) console.log(pc.dim(`  ${summary.failures} step failure(s) along the way`));
}
