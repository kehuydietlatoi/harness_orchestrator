/** Pure wire contract for OpenCode 1.19.3 `run --format json`. */
export function buildOpencodeArgv(options: {
  model: string;
  variant?: string;
  resumeSession?: string;
  title?: string;
}): string[] {
  const args = ["run", "--format", "json", "-m", options.model];
  if (options.variant !== undefined) args.push("--variant", options.variant);
  if (options.resumeSession !== undefined) args.push("-s", options.resumeSession);
  if (options.title !== undefined) args.push("--title", options.title);
  return args;
}

export type OpencodeOutcome =
  | "timedOut" | "quota" | "endpoint-unavailable" | "auth" | "failed"
  | "spawn-failure" | "incomplete" | "completed";

export interface OpencodeError {
  statusCode: number | null;
  isRetryable: boolean;
  retryAfterMs?: number;
}

export interface OpencodeResult {
  outcome: OpencodeOutcome;
  sessionId: string | null;
  resultText: string;
  usage: {
    tokensIn: number;
    tokensOut: number;
    cachedInputTokens: number;
    costUsd: number;
    requests: number;
  };
  error?: OpencodeError;
}

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject : {};
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorInfo(event: JsonObject): OpencodeError {
  const data = object(object(event.error).data);
  const statusCode = typeof data.statusCode === "number" ? data.statusCode : null;
  const headers = object(data.responseHeaders);
  const retryAfter = Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
  // Delta seconds need no wall clock, keeping the reducer deterministic.
  const seconds = typeof retryAfter === "string" && retryAfter.trim() !== ""
    ? Number(retryAfter) : typeof retryAfter === "number" ? retryAfter : NaN;
  return {
    statusCode,
    isRetryable: data.isRetryable === true,
    ...(Number.isFinite(seconds) && seconds >= 0 ? { retryAfterMs: seconds * 1000 } : {}),
  };
}

function errorOutcome(error: OpencodeError): OpencodeOutcome {
  if (error.statusCode === 429) return "quota";
  if ((error.statusCode !== null && error.statusCode >= 500) || error.isRetryable) return "endpoint-unavailable";
  if (error.statusCode === 401 || error.statusCode === 403) return "auth";
  return "failed";
}

/** Reduce stdout JSONL and process facts; tool errors are not terminal errors. */
export function reduceOpencode(input: {
  lines: string;
  exitCode: number;
  timedOut: boolean;
  stderr: string;
}): OpencodeResult {
  const result: OpencodeResult = {
    outcome: "incomplete",
    sessionId: null,
    resultText: "",
    usage: { tokensIn: 0, tokensOut: 0, cachedInputTokens: 0, costUsd: 0, requests: 0 },
  };
  let eventCount = 0;
  let lastReason: unknown;
  const errors: OpencodeError[] = [];
  for (const line of input.lines.split(/\r?\n/)) {
    let event: JsonObject;
    try { event = object(JSON.parse(line)); } catch { continue; }
    if (typeof event.type !== "string") continue;
    if (eventCount++ === 0) result.sessionId = typeof event.sessionID === "string" ? event.sessionID : null;
    const part = object(event.part);
    switch (event.type) {
      case "step_start": result.usage.requests++; break;
      case "text":
        if (typeof part.text === "string") result.resultText = part.text;
        break;
      case "step_finish": {
        lastReason = part.reason;
        const tokens = object(part.tokens);
        result.usage.tokensIn += number(tokens.input);
        result.usage.tokensOut += number(tokens.output);
        result.usage.cachedInputTokens += number(object(tokens.cache).read);
        result.usage.costUsd += number(part.cost);
        break;
      }
      case "error": errors.push(errorInfo(event)); break;
    }
  }
  // Choose across all error events in the documented precedence order.
  const priority: OpencodeOutcome[] = ["quota", "endpoint-unavailable", "auth", "failed"];
  errors.sort((a, b) => priority.indexOf(errorOutcome(a)) - priority.indexOf(errorOutcome(b)));
  if (errors.length > 0) result.error = errors[0];
  if (input.timedOut) result.outcome = "timedOut";
  else if (result.error) result.outcome = errorOutcome(result.error);
  else if (input.exitCode !== 0 && eventCount === 0) result.outcome = "spawn-failure";
  else if (lastReason !== "stop" || input.stderr.includes("auto-rejecting")) result.outcome = "incomplete";
  else result.outcome = "completed";
  return result;
}
