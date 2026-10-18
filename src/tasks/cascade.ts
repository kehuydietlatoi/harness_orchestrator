import { EFFORT_TIERS, type CascadeRoute, type OrchConfig } from "../config.js";
import { validateRoute } from "../routing/route-policy.js";

function routeKey(route: CascadeRoute, cfg: OrchConfig): string {
  // Config validation makes agent/model unique within a tier. Resolve inherited
  // model ids so callers can pass a member with omitted model/effort fields.
  return JSON.stringify([route.tier, route.agent, route.model ?? cfg.adapters[route.agent]?.models?.[route.tier]?.model ?? null]);
}

/** Walk forward only. An absent ladder preserves the existing retry/wait policy. */
export function nextHop(
  current: CascadeRoute,
  tried: readonly CascadeRoute[],
  role: string | undefined,
  cfg: OrchConfig,
): CascadeRoute | null {
  if (!cfg.tierMembers) return null;
  const visited = new Set([current, ...tried].map((route) => routeKey(route, cfg)));
  for (const tier of EFFORT_TIERS.slice(EFFORT_TIERS.indexOf(current.tier))) {
    const members = cfg.tierMembers[tier].map((member) => ({
      ...cfg.adapters[member.agent]?.models?.[tier], ...member, tier,
    }));
    const start = tier === current.tier ? members.findIndex((member) => routeKey(member, cfg) === routeKey(current, cfg)) + 1 : 0;
    // A current member outside the configured order cannot safely restart that tier.
    if (tier === current.tier && start === 0) continue;
    for (const member of members.slice(start)) {
      if (!cfg.agents.includes(member.agent) || !cfg.adapters[member.agent] || visited.has(routeKey(member, cfg))) continue;
      if (validateRoute({ ...member, role, model: member }, cfg).ok) return member;
    }
  }
  return null;
}
