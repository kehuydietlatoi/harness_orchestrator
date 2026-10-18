import { resolveFamily, type EffortTier, type ModelSpec, type OrchConfig } from "../config.js";

export type RoutePolicyConfig = Partial<Pick<OrchConfig, "roles" | "adapters" | "tierMembers">>;
export type RouteResult = { ok: true } | { ok: false; reason: string };

/** No role label preserves existing unrestricted routing. */
export function issueRole(issue: { labels: readonly string[] }): string | undefined {
  return issue.labels.find((label) => label.startsWith("role:"))?.slice(5);
}

/** Pure policy check shared by routing proposals, assignment, and execution. */
export function validateRoute(
  { role, agent, tier, model }: { role?: string; agent: string; tier: EffortTier; model?: ModelSpec },
  cfg: RoutePolicyConfig,
): RouteResult {
  if (role === undefined) return { ok: true };
  const allowance = cfg.roles && Object.hasOwn(cfg.roles, role) ? cfg.roles[role] : undefined;
  if (!allowance) return { ok: false, reason: `unknown role '${role}'` };
  if (!allowance.tiers.includes(tier)) {
    return { ok: false, reason: `role '${role}' does not allow tier '${tier}'` };
  }
  const first = cfg.tierMembers?.[tier].find((member) => member.agent === agent);
  const family = resolveFamily(agent, model ?? { ...cfg.adapters?.[agent]?.models?.[tier], ...first }, cfg);
  if (!family || !allowance.families.includes(family)) {
    return { ok: false, reason: `role '${role}' does not allow family '${family ?? "unknown"}' for '${agent}'` };
  }
  return { ok: true };
}
