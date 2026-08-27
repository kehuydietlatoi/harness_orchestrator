import pc from "picocolors";
import { loadConfig } from "../config.js";
import {
  discoverRepairIssues,
  reconcileIssue,
  type RepairAction,
  type RepairResult,
} from "../tasks/reconcile.js";

function actionDescription(action: RepairAction): string {
  switch (action.kind) {
    case "prune-worktree-registration":
      return `prune stale worktree registration at ${action.path}`;
    case "restore-branch":
      return `restore ${action.branch} from PR #${action.pr}`;
    case "acquire-lock":
      return "restore the claim lock";
    case "add-worktree":
      return "restore the task worktree registration";
    case "safe-remove-worktree":
      return `safely remove ${action.path}`;
    case "release-lock":
      return "release the stale claim lock";
    case "close-issue":
      return `close the issue projected by merged PR #${action.pr}`;
    case "supersede-telemetry":
      return "record recovery of the stale run outcome";
    case "sync-labels": {
      const parts = [
        action.add.length ? `add [${action.add.join(", ")}]` : "",
        action.remove.length ? `remove [${action.remove.join(", ")}]` : "",
      ].filter(Boolean);
      return `sync lifecycle labels: ${parts.join("; ")}`;
    }
  }
}

function printResult(result: RepairResult, apply: boolean): void {
  const heading = `#${result.issue} ${result.state.kind}`;
  console.log(apply ? pc.cyan(heading) : pc.bold(heading));
  if (apply && result.applied.length > 0) {
    for (const action of result.applied) {
      console.log(pc.green(`  applied: ${actionDescription(action)}`));
    }
  }
  if (result.actions.length === 0) {
    console.log(pc.dim("  no repair actions"));
  } else {
    for (const action of result.actions) {
      console.log(`  ${apply ? "remaining" : "would"}: ${actionDescription(action)}`);
    }
  }
  for (const reason of result.blocked) console.log(pc.yellow(`  preserved: ${reason}`));
}

/** Preview lifecycle repairs by default. `--apply` is the only mutating mode. */
export async function repairCommand(
  issueArg: string | undefined,
  opts: { apply?: boolean },
): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  let numbers: number[];
  if (issueArg === undefined) {
    numbers = await discoverRepairIssues(cwd);
  } else {
    const number = Number(issueArg);
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error(`invalid issue number: ${issueArg}`);
    }
    numbers = [number];
  }

  if (numbers.length === 0) {
    console.log(pc.dim("No orchestrator task resources found."));
    return;
  }
  if (!opts.apply) console.log(pc.dim("Preview only — pass --apply to execute these repairs."));
  for (const number of numbers) {
    const result = await reconcileIssue(number, cfg, cwd, { apply: opts.apply });
    printResult(result, opts.apply === true);
  }
}
