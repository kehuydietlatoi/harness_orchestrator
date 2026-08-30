import pc from "picocolors";
import { listIssues } from "../github/github.js";
import { buildGraph, formatCycle } from "../board/graph.js";

/**
 * Surface dependency cycles on the board to stderr and return how many were
 * found. Called by the runtime guard (`orch next` / `orch run`) so a deadlocked
 * group is named explicitly instead of hiding behind "nothing to do". Warnings
 * go to stderr so they never pollute machine-readable stdout.
 */
export async function reportCycles(cwd: string): Promise<number> {
  const issues = await listIssues({ cwd, state: "open" });
  const { cycles } = buildGraph(issues);
  for (const cycle of cycles) {
    console.error(
      pc.yellow(
        `⚠ Dependency cycle: ${formatCycle(cycle)} — none of these can run until the cycle is broken.`,
      ),
    );
  }
  if (cycles.length > 0) {
    console.error(pc.dim("  Edit one issue's `Depends-on:` line to break the cycle, then retry."));
  }
  return cycles.length;
}
