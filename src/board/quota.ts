import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectStateDir } from "./telemetry.js";
import { log } from "../util/log.js";

export function quotaPath(cwd: string): string {
  return join(projectStateDir(cwd), "quota.json");
}

/** Best-effort UTC daily request totals, keyed by resolved endpoint (including provider). */
export function incrementQuota(endpoint: string, requests: number, cwd: string, now = new Date()): void {
  if (!Number.isInteger(requests) || requests < 0) return;
  try {
    const path = quotaPath(cwd);
    let store: Record<string, Record<string, number>> = {};
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) store = raw as typeof store;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    const day = now.toISOString().slice(0, 10);
    const previous = store[day];
    const counts = previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
    const count = Object.hasOwn(counts, endpoint) ? counts[endpoint] : 0;
    store[day] = { ...counts, [endpoint]: (Number.isSafeInteger(count) && count >= 0 ? count : 0) + requests };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(store, null, 2), "utf8");
  } catch (error) {
    log.warn(`could not record quota usage: ${error instanceof Error ? error.message : String(error)}`);
  }
}
