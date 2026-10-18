/** Default for endpoint failures without a provider reset time, including health probes. */
export const ENDPOINT_COOLDOWN_MS = 10 * 60_000;

/** A harness refused work because its subscription/rate budget is exhausted. */
export interface UsageLimit {
  /** ISO time the limit is expected to lift, or null when the log gave none. */
  resetAt: string | null;
  /** The provider's own message, for operator output. */
  message: string;
}

const LIMIT_RE = /(usage|rate)[ _-]limit|limit reached|hit your limit|out of (credits|usage)/i;
const CLOCK_RE = /(?:try again at|resets?(?: at)?)\s+(?:([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Resolve a provider reset in local time. A bare "4:33 PM" uses the next
 * occurrence; an explicit date ("Oct 19th, 2026 12:07 AM") is kept as given. Pure.
 */
export function nextClockTime(text: string, now: Date): string | null {
  const m = text.match(CLOCK_RE);
  if (!m) return null;
  const clockHour = Number(m[4]);
  const minute = m[5] ? Number(m[5]) : 0;
  if (clockHour < 1 || clockHour > 12 || minute > 59) return null;
  let hour = clockHour % 12;
  if (m[6].toLowerCase() === "pm") hour += 12;
  const at = new Date(now);
  if (m[1]) {
    const monthText = m[1].toLowerCase();
    const month = MONTHS.findIndex((name) => name === monthText || name.slice(0, 3) === monthText);
    const day = Number(m[2]);
    const year = Number(m[3]);
    if (month < 0) return null;
    at.setFullYear(year, month, day);
    // Date normalizes impossible dates (e.g. February 30); reject those.
    if (at.getFullYear() !== year || at.getMonth() !== month || at.getDate() !== day) return null;
  }
  at.setHours(hour, minute, 0, 0);
  if (!m[1] && at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.toISOString();
}

function limitFrom(message: string, now: Date, epochSeconds?: number): UsageLimit {
  const resetAt =
    typeof epochSeconds === "number" && Number.isFinite(epochSeconds)
      ? new Date(epochSeconds * 1000).toISOString()
      : nextClockTime(message, now);
  return { resetAt, message };
}

function opencodeLimit(event: Record<string, unknown>, now: Date): UsageLimit | null {
  if (event.type !== "error") return null;
  const data = (event.error as { data?: Record<string, unknown> } | undefined)?.data;
  if (!data) return null;
  const status = data.statusCode;
  if (status !== 429 && !(typeof status === "number" && status >= 500) && data.isRetryable !== true) return null;
  let reset = now.getTime() + ENDPOINT_COOLDOWN_MS;
  if (status === 429) {
    const headers = data.responseHeaders;
    if (headers && typeof headers === "object" && !Array.isArray(headers)) {
      const normalized = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      const retry = normalized["retry-after"];
      const epoch = normalized["x-ratelimit-reset"];
      const retryText = typeof retry === "string" || typeof retry === "number" ? String(retry).trim() : "";
      const epochText = typeof epoch === "string" || typeof epoch === "number" ? String(epoch).trim() : "";
      const seconds = retryText ? Number(retryText) : NaN;
      const date = retryText && !Number.isFinite(seconds) ? Date.parse(retryText) : NaN;
      const resetSeconds = epochText ? Number(epochText) : NaN;
      if (Number.isFinite(seconds) && seconds >= 0) reset = now.getTime() + seconds * 1000;
      else if (Number.isFinite(date)) reset = date;
      else if (Number.isFinite(resetSeconds) && resetSeconds >= 0 && Number.isFinite(new Date(resetSeconds * 1000).getTime())) {
        reset = resetSeconds * 1000;
      }
    }
  }
  // Invalid/overflowing headers must fall back to the endpoint default.
  if (!Number.isFinite(new Date(reset).getTime())) reset = now.getTime() + ENDPOINT_COOLDOWN_MS;
  return {
    resetAt: new Date(reset).toISOString(),
    message: typeof data.message === "string" ? data.message : `OpenCode endpoint error (${String(status ?? "retryable")})`,
  };
}

/**
 * Detect a usage/rate-limit refusal in a harness JSONL log. Pure.
 *
 * Only error-shaped events count, never ordinary assistant text, so a task that
 * merely *mentions* rate limiting cannot mark a harness unavailable:
 *   - Codex: `{"type":"error"|"turn.failed", ...message}` ("You've hit your usage
 *     limit ... try again at 4:33 PM")
 *   - Claude: a `rate_limit_event` whose status is not allowed (carries `resetsAt`),
 *     or an `is_error` result whose text names the limit.
 */
export function detectUsageLimit(logText: string, now: Date = new Date()): UsageLimit | null {
  let found: UsageLimit | null = null;
  for (const line of logText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const endpointLimit = opencodeLimit(event, now);
    if (endpointLimit) {
      found = endpointLimit;
    } else if (event.type === "error" && typeof event.message === "string" && LIMIT_RE.test(event.message)) {
      found = limitFrom(event.message, now);
    } else if (event.type === "turn.failed") {
      const message = (event.error as { message?: unknown } | undefined)?.message;
      if (typeof message === "string" && LIMIT_RE.test(message)) found = limitFrom(message, now);
    } else if (event.type === "rate_limit_event") {
      const info = event.rate_limit_info as
        | { status?: unknown; resetsAt?: unknown; rateLimitType?: unknown }
        | undefined;
      const status = typeof info?.status === "string" ? info.status : "allowed";
      if (!status.startsWith("allowed")) {
        found = limitFrom(
          `Claude ${String(info?.rateLimitType ?? "usage")} limit (${status})`,
          now,
          typeof info?.resetsAt === "number" ? info.resetsAt : undefined,
        );
      }
    } else if (event.type === "result" && event.is_error === true && typeof event.result === "string") {
      if (LIMIT_RE.test(event.result)) found = limitFrom(event.result, now);
    }
  }
  return found;
}
