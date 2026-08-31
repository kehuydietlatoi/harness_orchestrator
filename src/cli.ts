#!/usr/bin/env node
import { Command } from "commander";
import { log, setLogLevel } from "./util/log.js";
import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor.js";
import { nextCommand } from "./commands/next.js";
import { claimCommand } from "./commands/claim.js";
import { submitCommand } from "./commands/submit.js";
import { abandonCommand } from "./commands/abandon.js";
import { boardCommand } from "./commands/board.js";
import { statusCommand } from "./commands/status.js";
import { runCommand } from "./commands/run.js";
import {
  reviewQueueCommand,
  reviewCommand,
  reviewApproveCommand,
  reviewChangesCommand,
} from "./commands/review.js";
import { mergeCommand, integrateCommand } from "./commands/merge.js";
import { briefCommand } from "./commands/brief.js";
import { memoryAddCommand, memoryListCommand } from "./commands/memory.js";
import { planCommand } from "./commands/plan.js";
import { assignCommand } from "./commands/assign.js";
import { snapshotCommand } from "./commands/snapshot.js";
import { serveCommand } from "./commands/serve.js";
import { dispatchCommand } from "./commands/dispatch.js";
import { repairCommand } from "./commands/repair.js";

/** Wrap an async action so thrown errors print cleanly and set a non-zero exit code. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrap(fn: (...args: any[]) => Promise<void>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (...args: any[]): Promise<void> => {
    try {
      await fn(...args);
    } catch (e) {
      log.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  };
}

const program = new Command();

program
  .name("orch")
  .description(
    "Run Claude Code + Codex as parallel coding agents with atomic task-claim, git-worktree isolation, and mandatory cross-harness review before merge.",
  )
  .version("0.1.0")
  .option("-v, --verbose", "verbose diagnostics on stderr (debug level)")
  .option("-q, --quiet", "quiet: only errors on stderr")
  // Apply the verbosity flags before any command action runs. Without a flag the
  // level stays at its ORCH_LOG_LEVEL / default value.
  .hook("preAction", () => {
    const opts = program.opts<{ verbose?: boolean; quiet?: boolean }>();
    if (opts.verbose) setLogLevel("debug");
    else if (opts.quiet) setLogLevel("error");
  });

const agentOpt = "-a, --agent <id>";
const agentDesc = "agent identity (defaults to $ORCH_AGENT or config.lead)";

program
  .command("init")
  .description("Scaffold config, the AGENTS.md/CLAUDE.md memory redirect, and GitHub labels")
  .action(wrap(initCommand));

program
  .command("doctor")
  .description("Verify environment: git, gh auth, worktree support, config, adapters, labels")
  .action(wrap(doctorCommand));

program
  .command("next")
  .description("Claim the next eligible issue, open a worktree, and print the brief")
  .option(agentOpt, agentDesc)
  .action(wrap(nextCommand));

program
  .command("claim <issue>")
  .description("Claim a specific issue by number")
  .option(agentOpt, agentDesc)
  .action(wrap(claimCommand));

program
  .command("submit <issue>")
  .description("Push the branch, open a PR that closes the issue, and route cross-review")
  .option(agentOpt, agentDesc)
  .action(wrap(submitCommand));

program
  .command("abandon <issue>")
  .description("Release a stuck claim safely; destructive cleanup requires --discard")
  .option(agentOpt, agentDesc)
  .option("--discard", "explicitly destroy retained work in the task worktree")
  .action(wrap(abandonCommand));

program
  .command("repair [issue]")
  .description("Preview lifecycle reconciliation, or execute safe idempotent repairs with --apply")
  .option("--apply", "execute the proposed repairs (preview-only by default)")
  .action(wrap(repairCommand));

program
  .command("board")
  .description("Show all issues grouped by status")
  .action(wrap(boardCommand));

program
  .command("status")
  .description("What you're working on, what's next, and what other agents are doing")
  .option(agentOpt, agentDesc)
  .action(wrap(statusCommand));

program
  .command("snapshot")
  .description("Project the complete open-task board as a table or JSON")
  .option("--json", "print the snapshot as JSON")
  .action(wrap(snapshotCommand));

program
  .command("serve")
  .description("Serve the live localhost control-plane dashboard")
  .option("--port <n>", "localhost port", "4000")
  .option("--demo", "serve a self-contained demo with seeded data (no gh, git, or claude needed)")
  .action(wrap(serveCommand));

program
  .command("run")
  .description("Dispatcher: claim eligible issues and drive the harness over them in worktrees")
  .option(agentOpt, agentDesc)
  .option("-m, --max <n>", "max concurrent tasks (defaults to config.maxConcurrent)")
  .option("--once", "process a single task then exit")
  .action(wrap(runCommand));

program
  .command("dispatch <issue>")
  .description("Claim and drive one routed todo by issue number")
  .action(wrap(dispatchCommand));

program
  .command("review-queue")
  .description("List PRs awaiting your cross-review")
  .option(agentOpt, agentDesc)
  .action(wrap(reviewQueueCommand));

program
  .command("review <pr>")
  .description("Print a PR's diff and a review checklist")
  .option(agentOpt, agentDesc)
  .action(wrap(reviewCommand));

program
  .command("review-approve <pr>")
  .description("Record a cross-review approval (satisfies the merge gate)")
  .option(agentOpt, agentDesc)
  .option("-n, --notes <text>", "optional approval note")
  .action(wrap(reviewApproveCommand));

program
  .command("review-changes <pr>")
  .description("Request changes and bounce the issue back to its author")
  .option(agentOpt, agentDesc)
  .option("-n, --notes <text>", "what needs to change (required)")
  .action(wrap(reviewChangesCommand));

program
  .command("merge <pr>")
  .description("Merge a PR — gated on green CI + approval by the other harness")
  .option("--human", "satisfy requireHumanMerge (your explicit sign-off)")
  .action(wrap(mergeCommand));

program
  .command("integrate")
  .description("Merge every PR that passes the gate, in order")
  .option("--human", "satisfy requireHumanMerge for all")
  .action(wrap(integrateCommand));

program
  .command("brief <issue>")
  .description("Print the task briefing (spec + memory pointer + loop) for an issue")
  .option(agentOpt, agentDesc)
  .action(wrap(briefCommand));

const memory = program.command("memory").description("Shared project memory (AGENTS.md)");
memory
  .command("add <text>")
  .description("Append a durable fact to shared memory")
  .option("-t, --type <type>", "fact type (note|decision|gotcha)", "note")
  .action(wrap(memoryAddCommand));
memory.command("list").description("List logged facts").action(wrap(memoryListCommand));

program
  .command("plan [file]")
  .description("Plan work: adapter-supported interactive session (no args), one-shot draft, preview, or create issues")
  .option("--draft <goal>", "one-shot: draft a tickets.json from a goal headlessly (LLM; prints JSON)")
  .option("--dry-run", "validate a tickets file and preview the issues without creating them")
  .option("--example", "print an annotated example tickets.json")
  .action(wrap(planCommand));

program
  .command("assign")
  .description("Emit a telemetry-grounded routing brief, run the judge, or apply an assignment plan")
  .option("--judge", "run the headless judge and print the assignment plan it proposes")
  .option("--auto", "run the judge and apply its plan (adds assigned-by:brain)")
  .option("--apply <plan>", "apply an assignment plan from a JSON file (use - for stdin)")
  .option("--dry-run", "print the label changes without writing them (with --apply or --auto)")
  .option("--round-robin", "use the legacy eligible-issue round-robin assignment")
  .action(wrap(assignCommand));

// Last-resort net for a rejection that escapes a wrapped action (e.g. a parse
// failure or an unwrapped hook); wrap() still handles ordinary command errors.
process.on("unhandledRejection", (reason) => {
  log.error(reason instanceof Error ? reason.message : String(reason));
  process.exit(1);
});

program.parseAsync(process.argv).catch((e: unknown) => {
  log.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
