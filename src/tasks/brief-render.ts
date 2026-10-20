import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OrchConfig } from "../config.js";
import type { Issue } from "../github/github.js";
import { projectStateDir } from "../board/telemetry.js";
import { issueRole } from "../routing/route-policy.js";
import { parseTicketV2 } from "./ticket-metadata.js";
import { issueBudgetStatus } from "./budget-runtime.js";
import { designReferenceErrors, loadDesignContext, markdownSection } from "./brief-context.js";

const bullets = (items: string[]) => items.filter(s => s.trim()).map(s => `- ${s}`).join("\n");
const gitRules = "No git commits, pushes, rebases or branch changes; orch commits and submits your work.";
const sectionBody = (body: string, heading: string) => markdownSection(body, heading)?.replace(/^.*\n?/, "").trim() ?? "";
const listSection = (body: string, heading: string) => {
  const lines = sectionBody(body, heading).split("\n");
  const end = lines.findIndex(line => line.trim() && !line.startsWith("- "));
  return (end < 0 ? lines : lines.slice(0, end)).join("\n").trim();
};
const matches = (path: string, glob: string) => new RegExp("^" + glob.split("**").map(part => part.split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*") + "$").test(path);

/** Render exactly once: substituted issue text is never interpreted as template syntax. */
export function renderPackBrief(issue: Issue, cfg: OrchConfig, cwd: string, priorAttempt = ""): string {
  const pack = cfg.loadedPack;
  if (!pack) throw new Error("pack is configured but not loaded");
  const ticket = parseTicketV2(issue.body);
  const roleId = issueRole(issue) ?? ticket.role;
  const role = roleId && Object.hasOwn(pack.roles, roleId) ? pack.roles[roleId] : undefined;
  if (!role) throw new Error(`role: unknown pack role ${roleId ?? "(missing)"}`);
  const design = loadDesignContext(cwd);
  const errors = designReferenceErrors(ticket, design);
  let studio: { protected_paths?: string[]; roles?: Record<string, { write_scope?: string[] }> } = {};
  const studioPath = resolve(cwd, "studio.config.json");
  if (existsSync(studioPath)) studio = JSON.parse(readFileSync(studioPath, "utf8").replace(/^\uFEFF/, ""));
  const scope = studio.roles?.[roleId!]?.write_scope ?? role.manifest.write_scope;
  const filesLine = /^\*\*Files \(ownership hint\):\*\* (.*)$/m.exec(issue.body)?.[1];
  const files = filesLine ? [...filesLine.matchAll(/`([^`]+)`/g)].map(m => m[1]) : [];
  const allowed = (files.length ? files.filter(file => scope.some(glob => matches(file, glob))) : scope)
    .filter(file => !role.manifest.forbidden.some(glob => matches(file, glob)));
  let remaining = 6000;
  const context = (ticket.context ?? []).map(anchor => {
    const entry = design.anchors[anchor];
    if (!entry?.text) return "";
    const text = `### ${anchor} (${entry.path})\n${entry.text}`;
    if (text.length > remaining) return `${anchor}: ${entry.path}`;
    remaining -= text.length + 2;
    return text;
  }).join("\n\n");
  const memoryPath = resolve(cwd, "AGENTS.md");
  const conventions = existsSync(memoryPath) ? sectionBody(readFileSync(memoryPath, "utf8"), "Conventions") : "";
  const budget = issueBudgetStatus(issue, cfg, cwd).remaining;
  if (ticket.observe && !cfg.evidence?.length) errors.push("observe requires config evidence argv");
  const command = (argv: string[]) => argv.map(arg => /^[\w./:@%+=,-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(" ");
  const scenariosDir = (cfg.scenariosDir ?? "qa/scenarios").replace(/\\/g, "/").replace(/\/$/, "");
  const observe = ticket.observe ? [
    "# OBSERVE",
    "A judge checks the Observe: acceptance lines against these scenarios on the final commit.",
    ...ticket.observe.map(name => `- ${name}: ${command([...(cfg.evidence ?? []), `${scenariosDir}/${name}.json`])} <tmp dir>`),
  ].join("\n") : "";
  const values: Record<string, string> = {
    "role.prompt": role.prompt.replace(/\r\n/g, "\n").trim(),
    "project.standing": [conventions, bullets(role.manifest.standing)].filter(Boolean).join("\n\n"),
    "project.protected_paths": [...new Set([...(studio.protected_paths ?? []), ...role.manifest.forbidden])].join(", "),
    "ticket.decisions_inline": (ticket.decisions ?? []).map(id => design.decisions[id]?.row ?? "").join("\n"),
    "ticket.goal": [issue.title.trim(), issue.body.trim().split(/\r?\n\s*\r?\n/)[0]].filter(Boolean).join("\n\n"),
    "ticket.files": allowed.join(", "),
    "ticket.locks": (ticket.locks ?? []).join(", "),
    "ticket.context_sections": context,
    "ticket.prior_attempt": priorAttempt,
    "ticket.acceptance": listSection(issue.body, "Definition of done"),
    "ticket.observe": observe,
    "ticket.verify": [...new Set([...(cfg.verify ?? []), ...(ticket.verify ?? [])]
      .map(argv => argv.map(arg => /^[\w./:@%+=,-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(" ")))].join("\n"),
    "ticket.budget": Object.keys(budget).length ? JSON.stringify(budget) : `Timeout: ${cfg.taskTimeoutMs / 60000} minutes`,
    "ticket.forbidden": [listSection(issue.body, "Out of scope"), bullets(role.manifest.forbidden), gitRules].filter(Boolean).join("\n"),
    "ticket.id": String(issue.number),
  };
  const template = readFileSync(resolve(pack.path, "briefs/brief.md.tmpl"), "utf8").replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").trimStart();
  const rendered = template.replace(/{{\s*(required\s+)?([^{}]+?)\s*}}/g, (_, required, key: string) => {
    if (!Object.hasOwn(values, key)) errors.push(`unknown brief placeholder ${key}`);
    const value = Object.hasOwn(values, key) ? values[key] : "";
    if (required && !value.trim()) errors.push(`required ${key} is empty`);
    return value;
  });
  if (errors.length) throw new Error(errors.join("; "));
  return rendered;
}

/** Exclusive creation gives retries monotonically numbered audit files without overwrites. */
export function storeBrief(issue: number, brief: string, cwd: string): string {
  const dir = resolve(projectStateDir(cwd), "briefs");
  mkdirSync(dir, { recursive: true });
  for (let attempt = 1; ; attempt++) {
    const path = resolve(dir, `issue-${issue}-${attempt}.md`);
    try { writeFileSync(path, brief, { encoding: "utf8", flag: "wx" }); return path; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
}
