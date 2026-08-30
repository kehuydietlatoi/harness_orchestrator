import pc from "picocolors";
import { commandExists } from "../util/exec.js";
import { isGitRepo, gitVersion, supportsWorktree, remoteUrl } from "../git/git.js";
import { ghInstalled, ghAuthenticated, listLabels, listIssues, getIssue } from "../github/github.js";
import { configExists, loadConfig } from "../config.js";
import type { OrchConfig } from "../config.js";
import { LABELS } from "../github/labels.js";
import { buildGraph, formatCycle, type UnresolvedDep } from "../board/graph.js";

/**
 * Classify each unresolved dependency as pointing at a closed issue vs a
 * nonexistent one. `getIssue` is used per unique dep — a single-target path, not
 * a hot loop — so `doctor` can report the two invariants distinctly.
 */
async function classifyUnresolved(
  deps: readonly UnresolvedDep[],
  cwd: string,
): Promise<{ closed: UnresolvedDep[]; missing: UnresolvedDep[] }> {
  const state = new Map<number, "closed" | "missing">();
  for (const dep of deps) {
    if (state.has(dep.dep)) continue;
    try {
      const issue = await getIssue(dep.dep, { cwd });
      state.set(dep.dep, issue.state.toUpperCase() === "CLOSED" ? "closed" : "missing");
    } catch {
      state.set(dep.dep, "missing");
    }
  }
  return {
    closed: deps.filter((d) => state.get(d.dep) === "closed"),
    missing: deps.filter((d) => state.get(d.dep) === "missing"),
  };
}

interface Check {
  name: string;
  ok: boolean;
  note?: string;
}

/** Commands doctor must validate, including a lead omitted from `agents`. Pure. */
export function configuredAdapterCommands(cfg: OrchConfig): Array<{ id: string; cmd: string }> {
  const ids = new Set([...cfg.agents, cfg.lead]);
  return [...ids].map((id) => ({ id, cmd: cfg.adapters[id]?.cmd ?? id }));
}

export async function doctorCommand(): Promise<void> {
  const cwd = process.cwd();
  const checks: Check[] = [];

  checks.push({ name: "git installed", ok: await commandExists("git"), note: await gitVersion().catch(() => "") });
  checks.push({ name: "inside a git repo", ok: await isGitRepo(cwd) });
  checks.push({ name: "git worktree support (>=2.15)", ok: await supportsWorktree() });

  const url = await remoteUrl(cwd);
  checks.push({ name: "origin remote", ok: !!url, note: url ?? "none" });

  const gh = await ghInstalled();
  checks.push({ name: "gh (GitHub CLI) installed", ok: gh, note: gh ? "" : "winget install GitHub.cli" });
  checks.push({ name: "gh authenticated", ok: gh ? await ghAuthenticated() : false, note: gh ? "" : "n/a" });

  const cfg = configExists(cwd);
  checks.push({ name: "orch.config.json present", ok: cfg, note: cfg ? "" : "run `orch init`" });

  let adapters: Array<{ id: string; cmd: string }> = [];
  if (cfg) {
    try {
      const loaded = loadConfig(cwd);
      adapters = configuredAdapterCommands(loaded);
    } catch {
      /* ignore malformed config here; presence check already recorded */
    }
  }
  for (const adapter of adapters) {
    checks.push({
      name: `adapter '${adapter.id}' CLI present`,
      ok: await commandExists(adapter.cmd),
      note: adapter.cmd === adapter.id ? "" : `configured command: ${adapter.cmd}`,
    });
  }

  if (gh && url) {
    const existing = new Set(await listLabels(cwd));
    const missing = LABELS.filter((l) => !existing.has(l.name)).map((l) => l.name);
    checks.push({
      name: "orch labels present",
      ok: missing.length === 0,
      note: missing.length ? `missing: ${missing.join(", ")} — run \`orch init\`` : "",
    });

    // Dependency-graph invariants (Q11 rows 1–3): a cycle deadlocks its group;
    // a dep on a closed issue is advisory; a dep on a nonexistent issue is a typo.
    if (await isGitRepo(cwd)) {
      const graph = buildGraph(await listIssues({ cwd, state: "open" }));
      checks.push({
        name: "no dependency cycles",
        ok: graph.cycles.length === 0,
        note: graph.cycles.length ? graph.cycles.map(formatCycle).join("  |  ") : "",
      });
      const { closed, missing: gone } = await classifyUnresolved(graph.unresolvedDeps, cwd);
      checks.push({
        name: "dependencies point at existing issues",
        ok: gone.length === 0,
        note: gone.length ? gone.map((d) => `#${d.issue}→#${d.dep} (no such issue)`).join(", ") : "",
      });
      if (closed.length > 0) {
        checks.push({
          name: "dependencies on closed issues",
          ok: true, // advisory only — closed deps are non-blocking by design
          note: closed.map((d) => `#${d.issue}→#${d.dep}`).join(", ") + " (closed; non-blocking)",
        });
      }
    }
  }

  console.log(pc.bold("orch doctor\n"));
  let allOk = true;
  for (const c of checks) {
    if (!c.ok) allOk = false;
    const mark = c.ok ? pc.green("✓") : pc.red("✗");
    console.log(`  ${mark} ${c.name}${c.note ? pc.dim("  — " + c.note) : ""}`);
  }
  console.log("");
  console.log(allOk ? pc.green("All checks passed.") : pc.yellow("Some checks failed — see notes above."));
  process.exitCode = allOk ? 0 : 1;
}
