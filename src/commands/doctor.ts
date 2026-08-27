import pc from "picocolors";
import { commandExists } from "../util/exec.js";
import { isGitRepo, gitVersion, supportsWorktree, remoteUrl } from "../git/git.js";
import { ghInstalled, ghAuthenticated, listLabels } from "../github/github.js";
import { configExists, loadConfig } from "../config.js";
import type { OrchConfig } from "../config.js";
import { LABELS } from "../github/labels.js";

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
