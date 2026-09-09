import pc from "picocolors";
import { loadConfig } from "../config.js";
import { resolveAgent } from "../tasks/service.js";
import { buildSnapshot, healthDetail, type TaskView } from "../board/snapshot.js";

export function formatStatusTask(task: TaskView): string {
  return `#${task.number} ${task.title} [${task.health.kind}]${healthDetail(task) ? ` — ${healthDetail(task)}` : ""}`;
}

export async function statusCommand(opts: { agent?: string }): Promise<void> {
  const cwd = process.cwd();
  const agent = resolveAgent(opts.agent, loadConfig(cwd));
  const snapshot = await buildSnapshot(cwd);
  console.log(pc.bold(`orch status — agent '${agent}'\n`));
  const sections: Array<[string, TaskView[]]> = [
    ["Working on (you)", snapshot.tasks.filter((t) => t.agent === agent)],
    ["Up next (eligible)", snapshot.tasks.filter((t) => t.health.kind === "ready" && !t.blockers.length && (!t.agent || t.agent === agent))],
    ["Needs attention", snapshot.tasks.filter((t) => t.recoveryCommand)],
    ["Other agents", snapshot.tasks.filter((t) => t.agent && t.agent !== agent)],
  ];
  for (const [title, tasks] of sections) {
    console.log(pc.bold(title));
    console.log(tasks.length ? tasks.map((t) => `  ${formatStatusTask(t)}`).join("\n") : "  (none)");
    console.log("");
  }
}
