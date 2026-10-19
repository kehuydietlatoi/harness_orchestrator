import { resolveCapabilities, resolveFamily, type EffortTier, type ModelSpec, type OrchConfig } from "../config.js";

export type RoutePolicyConfig = Partial<Pick<OrchConfig, "roles" | "adapters" | "tierMembers" | "sensitivity" | "pack">>;
export interface RouteRequirements {
  needs?: readonly string[];
  sensitivity?: "public" | "internal" | "secret";
}
export type RouteResult = { ok: true } | { ok: false; reason: string };

/** Provider selected by the same model/ladder precedence used at execution. */
export function routeFamily(agent: string, tier: EffortTier, cfg: RoutePolicyConfig, model?: ModelSpec): string | undefined {
  const first = cfg.tierMembers?.[tier].find((member) => member.agent === agent);
  return resolveFamily(agent, model ?? { ...cfg.adapters?.[agent]?.models?.[tier], ...first }, cfg);
}

/** No role label preserves existing unrestricted routing. */
export function issueRole(issue: { labels: readonly string[] }): string | undefined {
  return issue.labels.find((label) => label.startsWith("role:"))?.slice(5);
}

/** Pure policy check shared by routing proposals, assignment, and execution. */
export function validateRoute(
  { role, agent, tier, model, needs, sensitivity }: RouteRequirements & { role?: string; agent: string; tier: EffortTier; model?: ModelSpec },
  cfg: RoutePolicyConfig,
): RouteResult {
  const selected = model ?? { ...cfg.adapters?.[agent]?.models?.[tier], ...cfg.tierMembers?.[tier].find(m => m.agent === agent) };
  const future = needs?.filter(need => ["engine", "image-gen", "audio-gen"].includes(need));
  if (future?.length) return { ok: false, reason: `needs ${future.join(", ")} require tooling from Phases 3-4` };
  const missing = needs?.filter(need => !resolveCapabilities(agent, selected).includes(need));
  if (missing?.length) return { ok: false, reason: `needs ${missing.join(", ")} are not supported by '${agent}' model '${selected.model ?? "default"}'` };
  // Existing v1 projects remain unrestricted until they opt into these fields or policy.
  const level = sensitivity ?? cfg.sensitivity?.default ??
    (needs !== undefined || cfg.pack !== undefined || cfg.sensitivity !== undefined ? "internal" : "public");
  const family = routeFamily(agent, tier, cfg, selected);
  if (level !== "public") {
    const families = cfg.sensitivity?.[level]?.families ?? ["anthropic", "openai"];
    const allowed = agent === "opencode"
      ? level === "internal" && selected.model !== undefined && (cfg.sensitivity?.internal?.allow ?? []).includes(selected.model)
      : family !== undefined && families.includes(family);
    if (!allowed) return { ok: false, reason: `sensitivity '${level}' does not allow '${agent}' model '${selected.model ?? "default"}' (family '${family ?? "unknown"}')` };
  }
  if (role === undefined) return { ok: true };
  const allowance = cfg.roles && Object.hasOwn(cfg.roles, role) ? cfg.roles[role] : undefined;
  if (!allowance) return { ok: false, reason: `unknown role '${role}'` };
  if (!allowance.tiers.includes(tier)) {
    return { ok: false, reason: `role '${role}' does not allow tier '${tier}'` };
  }
  if (!family || !allowance.families.includes(family)) {
    return { ok: false, reason: `role '${role}' does not allow family '${family ?? "unknown"}' for '${agent}'` };
  }
  return { ok: true };
}
