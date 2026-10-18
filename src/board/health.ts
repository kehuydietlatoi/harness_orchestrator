import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdapterConfig } from "../config.js";
import { OpencodeAdapter } from "../adapters/opencode.js";
import { availabilityKey, markUnavailable, unavailableUntil } from "./availability.js";
import { projectStateDir } from "./telemetry.js";
import { log } from "../util/log.js";

export const HEALTH_TTL_MS = 10 * 60_000;
interface HealthResult { ts: number; ok: boolean }
export interface HealthDeps {
  now?: () => Date;
  ping?: (slug: string) => Promise<boolean>;
}

export function healthPath(cwd: string): string {
  return join(projectStateDir(cwd), "health.json");
}

function readHealth(cwd: string): Record<string, HealthResult> {
  try {
    const raw: unknown = JSON.parse(readFileSync(healthPath(cwd), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([, entry]) =>
      entry && typeof entry.ts === "number" && Number.isFinite(entry.ts) && typeof entry.ok === "boolean"));
  } catch { return {}; }
}

const pending = new Map<string, Promise<boolean>>();

/** Pre-claim endpoint gate. Health and cooldowns are runtime hints, never task state. */
export async function endpointHealthy(
  agent: string, slug: string | undefined, cwd: string,
  config?: AdapterConfig, deps: HealthDeps = {},
): Promise<boolean> {
  if (agent !== "opencode") return true;
  if (!slug) return false; // OpenCode cannot run without an explicit endpoint.
  const now = deps.now ?? (() => new Date());
  const key = availabilityKey(agent, slug);
  if (unavailableUntil(key, cwd, now())) return false;
  const cached = readHealth(cwd)[slug];
  const age = cached ? now().getTime() - cached.ts : Infinity;
  if (cached && age >= 0 && age < HEALTH_TTL_MS) return cached.ok;
  const pendingKey = JSON.stringify([healthPath(cwd), slug]);
  const existing = pending.get(pendingKey);
  if (existing) return existing;
  const check = (async () => {
    let ok = false;
    try {
      ok = await (deps.ping ?? ((model) => new OpencodeAdapter(config).pingEndpoint(model, cwd)))(slug);
    } catch { /* Spawn errors and timeouts are unhealthy too. */ }
    const checkedAt = now();
    try {
      const store = { ...readHealth(cwd), [slug]: { ts: checkedAt.getTime(), ok } };
      mkdirSync(dirname(healthPath(cwd)), { recursive: true });
      writeFileSync(healthPath(cwd), JSON.stringify(store, null, 2), "utf8");
    } catch (error) {
      log.warn(`could not record endpoint health: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!ok) {
      markUnavailable(key, { resetAt: null, reason: "endpoint health ping failed" }, cwd, checkedAt);
      log.warn(`'${key}' failed its health ping; skipping unclaimed work`);
    }
    return ok;
  })();
  pending.set(pendingKey, check);
  try { return await check; } finally { pending.delete(pendingKey); }
}
