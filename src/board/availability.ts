import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { detectUsageLimit } from "../adapters/usage-limit.js";
import { log } from "../util/log.js";
import { projectStateDir } from "./telemetry.js";

/** Used when a refusal names no reset time. */
export const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;
/** A parsed reset is clamped so a misread clock can never park a harness for days. */
const MAX_COOLDOWN_MS = 12 * 60 * 60 * 1000;

export interface Unavailability {
  until: string;
  reason: string;
  ts: string;
}

type Store = Record<string, Unavailability>;

export function availabilityPath(cwd: string): string {
  return join(projectStateDir(cwd), "availability.json");
}

function readStore(cwd: string): Store {
  try {
    const raw = JSON.parse(readFileSync(availabilityPath(cwd), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const store: Store = {};
    for (const [agent, v] of Object.entries(raw as Record<string, Partial<Unavailability>>)) {
      if (typeof v?.until === "string" && Number.isFinite(Date.parse(v.until))) {
        store[agent] = { until: v.until, reason: String(v.reason ?? ""), ts: String(v.ts ?? "") };
      }
    }
    return store;
  } catch {
    return {}; // missing/corrupt state means "nothing known" - never block work on it
  }
}

/**
 * Remember that `agent` is out of budget until `resetAt` (or a default cooldown).
 * Best-effort: availability is an optimisation, so IO errors only warn.
 */
export function markUnavailable(
  agent: string,
  info: { resetAt: string | null; reason: string },
  cwd: string,
  now: Date = new Date(),
): Date {
  const parsed = info.resetAt ? Date.parse(info.resetAt) : NaN;
  const wanted = Number.isFinite(parsed) ? parsed : now.getTime() + DEFAULT_COOLDOWN_MS;
  const until = new Date(Math.min(Math.max(wanted, now.getTime() + 60_000), now.getTime() + MAX_COOLDOWN_MS));
  try {
    const store = readStore(cwd);
    store[agent] = { until: until.toISOString(), reason: info.reason.slice(0, 300), ts: now.toISOString() };
    mkdirSync(dirname(availabilityPath(cwd)), { recursive: true });
    writeFileSync(availabilityPath(cwd), JSON.stringify(store, null, 2), "utf8");
  } catch (error) {
    log.warn(`could not record ${agent} availability: ${error instanceof Error ? error.message : String(error)}`);
  }
  return until;
}

/** When `agent`'s cooldown ends, or null when it is (believed) available. */
export function unavailableUntil(agent: string, cwd: string, now: Date = new Date()): Date | null {
  const entry = readStore(cwd)[agent];
  if (!entry) return null;
  const until = new Date(entry.until);
  return until.getTime() > now.getTime() ? until : null;
}

/** Every agent from `agents` currently on cooldown. */
export function unavailableAgents(agents: readonly string[], cwd: string, now: Date = new Date()): Set<string> {
  return new Set(agents.filter((agent) => unavailableUntil(agent, cwd, now) !== null));
}

/**
 * If a failed run's log shows a usage-limit refusal, put the harness on cooldown.
 * Returns the cooldown end, or null when the failure was something else.
 */
export function noteUsageLimitFromLog(agent: string, logText: string, cwd: string, now: Date = new Date()): Date | null {
  const limit = detectUsageLimit(logText, now);
  return limit ? markUnavailable(agent, { resetAt: limit.resetAt, reason: limit.message }, cwd, now) : null;
}
