import { expect, it } from "vitest";
import { buildBrief } from "../src/tasks/brief.js";

it("renders ticket verify argv explicitly for the worker's sandbox self-check", () => {
  const verify = [["node", "--test", "tests/a file.test.ts"]];
  const body = '## Ticket metadata (v2)\n\n```json\n' + JSON.stringify({ verify }) + '\n```';
  const brief = buildBrief({ number: 175, title: "Check", body, state: "OPEN", labels: [], assignees: [] },
    { path: "/worktree", branch: "task/175" }, "codex", process.cwd());
  expect(brief).toContain(`Self-check in your sandbox with verify argv: ${JSON.stringify(verify[0])}`);
});
