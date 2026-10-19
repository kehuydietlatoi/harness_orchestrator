import type { OrchConfig } from "../config.js";
import type { Issue } from "../github/github.js";
import type { RoleManifest } from "../pack/load.js";
import { pathMatchesGlob } from "../git/path-locks.js";
import { issueRole } from "../routing/route-policy.js";

export interface ScopeViolation { path: string; reason: string }

/** Callers supply deleted paths and both names of renames as concrete paths. */
export function scopeViolations(changedPaths: readonly string[], role: Pick<RoleManifest, "write_scope" | "forbidden">, files: readonly string[] = []): ScopeViolation[] {
  return [...new Set(changedPaths)].flatMap(path => {
    const forbidden = role.forbidden.find(pattern => pathMatchesGlob(pattern, path));
    if (forbidden) return [{ path, reason: `forbidden by ${forbidden}` }];
    return [...role.write_scope, ...files].some(pattern => pathMatchesGlob(pattern, path))
      ? [] : [{ path, reason: "outside write_scope" }];
  });
}

export class ScopeRejected extends Error {}

/** No pack or no role preserves the legacy path, including its I/O. */
export function issueScope(issue: Issue, cfg: OrchConfig): RoleManifest | undefined {
  const role = issueRole(issue);
  if (!cfg.pack || !role) return undefined;
  const manifest = cfg.loadedPack?.roles[role]?.manifest;
  if (!manifest) throw new Error(`Cannot check write_scope: pack role ${role} is unavailable`);
  return manifest;
}

export function ticketFiles(body: string): string[] {
  const line = /^\*\*Files \(ownership hint\):\*\* (.*)$/m.exec(body)?.[1];
  return line ? [...line.matchAll(/`([^`]+)`/g)].map(match => match[1]) : [];
}

export function scopeFailure(paths: readonly string[], role: Pick<RoleManifest, "write_scope" | "forbidden">, body: string): string | null {
  const violations = scopeViolations(paths, role, ticketFiles(body));
  return violations.length ? "Worker diff rejected; worktree and claim retained.\n\n" +
    violations.map(({ path, reason }) => `- ${JSON.stringify(path)}: ${reason}`).join("\n") : null;
}
