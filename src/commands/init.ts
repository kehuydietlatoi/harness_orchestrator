import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";
import { CONFIG_FILE, DEFAULT_CONFIG, configExists } from "../config.js";
import { isGitRepo, remoteUrl } from "../git/git.js";
import { ghInstalled, ensureLabel } from "../github/github.js";
import { LABELS } from "../github/labels.js";
import { ensurePlanSkill } from "../tasks/planner.js";

const AGENTS_MD = `# Project memory (canonical — read by ALL harnesses)

> **Write convention:** record durable project facts HERE, not in native harness memory.
> **Work loop:** \`orch next --agent <you>\` → work in the printed worktree → \`orch submit\`.
> **Review:** when \`orch review-queue --agent <you>\` is non-empty, review the other harness's PRs.

## Conventions
_(add project-specific facts, gotchas, and architectural decisions below)_
`;

const CLAUDE_MD = `# Claude Code memory

@AGENTS.md

_This file is a redirect. All project knowledge lives in AGENTS.md (read by every harness).
Do not store project facts here — add them to AGENTS.md so Codex sees them too._
`;

function writeIfAbsent(path: string, content: string, log: string[]): void {
  if (existsSync(path)) {
    log.push(pc.dim(`  = ${path} (exists, left as-is)`));
    return;
  }
  writeFileSync(path, content, "utf8");
  log.push(pc.green(`  + ${path}`));
}

/** Install the shipped orch-plan skill so `/orch-plan` — and the interactive
 * `orch plan` session — have the ticket contract. */
function installPlanSkill(cwd: string, log: string[]): void {
  const { path, created } = ensurePlanSkill(cwd);
  log.push(created ? pc.green(`  + ${path}`) : pc.dim(`  = ${path} (exists, left as-is)`));
}

export async function initCommand(): Promise<void> {
  const cwd = process.cwd();
  const log: string[] = [];

  if (!(await isGitRepo(cwd))) {
    console.log(pc.yellow("⚠ Not a git repository. Run `git init` and add a GitHub remote before using the work loop."));
  }

  if (configExists(cwd)) {
    log.push(pc.dim(`  = ${CONFIG_FILE} (exists, left as-is)`));
  } else {
    writeFileSync(resolve(cwd, CONFIG_FILE), JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
    log.push(pc.green(`  + ${CONFIG_FILE}`));
  }

  writeIfAbsent(resolve(cwd, "AGENTS.md"), AGENTS_MD, log);
  writeIfAbsent(resolve(cwd, "CLAUDE.md"), CLAUDE_MD, log);
  installPlanSkill(cwd, log);

  console.log(pc.bold("\nScaffolded files:"));
  log.forEach((l) => console.log(l));

  if (await ghInstalled()) {
    const url = await remoteUrl(cwd);
    if (!url) {
      console.log(pc.yellow("\n⚠ No `origin` remote — skipping GitHub label creation. Add a remote and re-run `orch init`."));
    } else {
      console.log(pc.bold("\nGitHub labels:"));
      for (const label of LABELS) {
        const r = await ensureLabel(label, cwd);
        const mark = r === "created" ? pc.green("+") : r === "exists" ? pc.dim("=") : pc.red("✗");
        console.log(`  ${mark} ${label.name}`);
      }
    }
  } else {
    console.log(pc.yellow("\n⚠ `gh` not installed — skipped label creation. Install: `winget install GitHub.cli`, then re-run `orch init`."));
  }

  console.log(pc.bold("\nNext: ") + "run `orch doctor` to verify your setup.");
}
