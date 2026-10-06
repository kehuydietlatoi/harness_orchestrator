import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectStateDir } from "../board/telemetry.js";
import { log } from "../util/log.js";

/**
 * The author's harness conversation for one task, kept so a later fix round can
 * *resume* it instead of cold-starting. Resume is an optimisation only: if the
 * record is missing, stale, or the harness refuses it, callers fall back to a fresh
 * session seeded from durable facts (the PR, its review history, the worktree).
 */
export interface TaskSession {
  agent: string;
  sessionId: string;
  updatedAt?: string;
}

export function sessionPath(issue: number, cwd: string): string {
  return join(projectStateDir(cwd), "sessions", `issue-${issue}.json`);
}

export function readSession(issue: number, cwd: string): TaskSession | null {
  try {
    const v = JSON.parse(readFileSync(sessionPath(issue, cwd), "utf8")) as Partial<TaskSession>;
    if (typeof v.agent === "string" && typeof v.sessionId === "string" && v.sessionId.length > 0) {
      return { agent: v.agent, sessionId: v.sessionId, updatedAt: v.updatedAt };
    }
  } catch {
    // missing or corrupt -> no session
  }
  return null;
}

/** Best-effort: a lost session only costs a cold start, never correctness. */
export function writeSession(issue: number, session: TaskSession, cwd: string): void {
  try {
    const path = sessionPath(issue, cwd);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...session, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  } catch (error) {
    log.warn(`could not record #${issue} session: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function clearSession(issue: number, cwd: string): void {
  try {
    rmSync(sessionPath(issue, cwd), { force: true });
  } catch {
    // best-effort
  }
}
