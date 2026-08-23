import pc from "picocolors";
import { basename } from "node:path";
import { loadConfig } from "../config.js";
import { buildSnapshot, type Snapshot, type TaskView } from "../snapshot.js";

function latestRun(task: TaskView): string {
  if (!task.latestRun) return "-";
  const tokens = task.latestRun.tokensTotal === null ? "?t" : `${task.latestRun.tokensTotal}t`;
  const cost = task.latestRun.costUsd === null ? "$?" : `$${task.latestRun.costUsd.toFixed(4)}`;
  return `${tokens}/${cost}`;
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

export function formatSnapshotTable(snapshot: Snapshot): string {
  if (snapshot.tasks.length === 0) return pc.dim("  (no open tasks)");

  const headers = ["TASK", "STATUS", "AGENT", "DEPS", "PR", "REVIEWED", "LOCK", "WORKTREE", "LATEST RUN"];
  const rows = snapshot.tasks.map((task) => [
    `#${task.number} ${task.title}`,
    task.status.replace(/^status:/, ""),
    task.agent ?? "-",
    task.deps.length > 0 ? task.deps.map((dep) => `#${dep}`).join(",") : "-",
    task.prNumber === null ? "-" : `#${task.prNumber}`,
    task.reviewedBy.join(",") || "-",
    task.locked ? "yes" : "-",
    task.worktree ? basename(task.worktree) : "-",
    latestRun(task),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );

  const render = (row: string[]): string =>
    row.map((cell, index) => pad(cell, widths[index])).join("  ").trimEnd();

  return [pc.bold(render(headers)), pc.dim(render(widths.map((width) => "-".repeat(width)))), ...rows.map(render)].join(
    "\n",
  );
}

export async function snapshotCommand(opts: { json?: boolean }): Promise<void> {
  const cwd = process.cwd();
  loadConfig(cwd);
  const snapshot = await buildSnapshot(cwd);

  if (opts.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  console.log(pc.bold("orch snapshot\n"));
  console.log(formatSnapshotTable(snapshot));
  const queue = snapshot.reviewQueue.map((pr) => `#${pr}`).join(", ");
  console.log(`\n${pc.bold("Review queue:")} ${queue || pc.dim("(empty)")}`);
}
