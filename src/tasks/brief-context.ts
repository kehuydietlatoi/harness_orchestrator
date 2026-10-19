import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { TicketV2 } from "./plan.js";

export interface DesignContext {
  decisions: Record<string, { row: string; status: string }>;
  anchors: Record<string, { path: string; text?: string; error?: string }>;
}

const read = (path: string) => readFileSync(path, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(s => s.trim().replace(/^`|`$/g, ""));

/** A heading and its subsections, stopping at the next peer or ancestor. */
export function markdownSection(markdown: string, title: string): string | undefined {
  const lines = markdown.split("\n");
  const start = lines.findIndex(line => /^#{1,6}\s+/.test(line) && line.replace(/^#+\s+/, "").trim() === title);
  if (start < 0) return undefined;
  const depth = /^#+/.exec(lines[start])![0].length;
  let end = start + 1;
  while (end < lines.length && !new RegExp(`^#{1,${depth}}\\s+`).test(lines[end])) end++;
  return lines.slice(start, end).join("\n").trim();
}

/** Snapshot project design IO at the boundary; plan validation remains pure. */
export function loadDesignContext(cwd: string): DesignContext {
  const result: DesignContext = { decisions: Object.create(null), anchors: Object.create(null) };
  try {
    for (const row of read(resolve(cwd, "design/decisions.md")).split("\n").filter(l => l.trim().startsWith("|"))) {
      const [id, , status] = cells(row);
      if (/^D-\d+$/.test(id)) result.decisions[id] = { row, status: status?.toLowerCase() ?? "" };
    }
  } catch { /* Missing registers are reported against each cited ID. */ }
  try {
    for (const row of read(resolve(cwd, "design/INDEX.md")).split("\n").filter(l => l.trim().startsWith("|"))) {
      const [anchor, file, heading] = cells(row);
      if (!/^[a-z0-9]+(?:\.[a-z0-9-]+)*$/.test(anchor) || !file || !heading) continue;
      const path = `design/${file}`;
      try {
        const root = resolve(cwd, "design");
        const target = resolve(root, file);
        const rel = relative(root, target);
        if (isAbsolute(file) || rel.startsWith("..") || isAbsolute(rel)) throw new Error("path is outside design/");
        const text = markdownSection(read(target), heading);
        if (!text) throw new Error(`missing section ${heading}`);
        result.anchors[anchor] = { path, text };
      } catch (error) { result.anchors[anchor] = { path, error: String(error) }; }
    }
  } catch { /* Missing index is reported against each cited anchor. */ }
  return result;
}

export function designReferenceErrors(ticket: TicketV2, design?: DesignContext): string[] {
  const errors: string[] = [];
  for (const id of ticket.decisions ?? []) {
    const decision = design?.decisions[id];
    if (!decision) errors.push(`decisions: unknown decision ${id} in design/decisions.md`);
    else if (/^superseded\b/.test(decision.status)) errors.push(`decisions: ${id} is superseded`);
  }
  for (const anchor of ticket.context ?? []) {
    const section = design?.anchors[anchor];
    if (!section?.text) errors.push(`context: anchor ${anchor} does not resolve in design/INDEX.md${section?.error ? ` (${section.error})` : ""}`);
  }
  return errors;
}
