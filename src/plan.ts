import { readFileSync } from "node:fs";
import { createIssue, listIssues, editIssue } from "./github.js";
import { STATUS, agentLabel } from "./labels.js";
import { issueAgent, isEligible } from "./board.js";
import type { OrchConfig } from "./config.js";

export interface Ticket {
  id?: string; // local id other tickets reference in dependsOn
  title: string;
  body?: string;
  dependsOn?: string[]; // local ids of earlier tickets
  files?: string[]; // file-ownership hints (to minimise overlap)
}

/** Pure: render the GitHub issue body from a ticket + resolved dependency numbers. */
export function renderTicketBody(ticket: Ticket, depNumbers: number[]): string {
  const parts: string[] = [];
  if (ticket.body) parts.push(ticket.body.trim());
  if (ticket.files?.length) {
    parts.push(`**Files (ownership hint):** ${ticket.files.map((f) => `\`${f}\``).join(", ")}`);
  }
  if (depNumbers.length) {
    parts.push(`Depends-on: ${depNumbers.map((n) => `#${n}`).join(", ")}`);
  }
  return parts.join("\n\n") || "_(no description)_";
}

export interface Created {
  id?: string;
  number: number;
  title: string;
}

/** Decompose a JSON tickets file into GitHub issues, wiring up dependencies. */
export async function planFromFile(file: string, cwd: string): Promise<Created[]> {
  const raw = readFileSync(file, "utf8").replace(/^﻿/, "");
  const tickets = JSON.parse(raw) as Ticket[];
  if (!Array.isArray(tickets)) throw new Error("tickets file must be a JSON array");

  const created: Created[] = [];
  const idToNumber = new Map<string, number>();
  for (const t of tickets) {
    if (!t.title) throw new Error("each ticket needs a title");
    const depNumbers = (t.dependsOn ?? [])
      .map((d) => idToNumber.get(d))
      .filter((n): n is number => n !== undefined);
    const body = renderTicketBody(t, depNumbers);
    const number = await createIssue(t.title, body, [STATUS.todo], { cwd });
    if (t.id) idToNumber.set(t.id, number);
    created.push({ id: t.id, number, title: t.title });
  }
  return created;
}

export interface Assignment {
  issue: number;
  agent: string;
}

/** Round-robin pre-assign eligible unowned issues to agents (a lead hint). */
export async function assignRoundRobin(cfg: OrchConfig, cwd: string): Promise<Assignment[]> {
  const issues = (await listIssues({ cwd, state: "open" })).sort((a, b) => a.number - b.number);
  const out: Assignment[] = [];
  let i = 0;
  for (const issue of issues) {
    if (issueAgent(issue)) continue; // already owned
    if (!(await isEligible(issue, cwd))) continue; // only actionable todo issues
    const agent = cfg.agents[i % cfg.agents.length];
    i++;
    await editIssue(issue.number, { cwd, addLabels: [agentLabel(agent)] });
    out.push({ issue: issue.number, agent });
  }
  return out;
}
