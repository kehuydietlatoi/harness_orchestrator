import pc from "picocolors";

/**
 * Minimal leveled logger for *diagnostics* — warnings, errors, and verbose
 * tracing from background/lifecycle paths. It writes to **stderr** so that a
 * command's machine-readable stdout (board/status/snapshot JSON) stays clean;
 * user-facing command output should keep using `console.log` on stdout.
 *
 * Level is taken from `ORCH_LOG_LEVEL` (silent|error|warn|info|debug) and can be
 * overridden at runtime by the CLI's `--verbose`/`--quiet` flags via
 * {@link setLogLevel}. Tests redirect output with {@link setLogSink}.
 */
export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const ORDER: readonly LogLevel[] = ["silent", "error", "warn", "info", "debug"];

/** Parse a level name (case-insensitive); null when unset or unrecognized. */
export function parseLogLevel(value: string | undefined): LogLevel | null {
  const v = value?.trim().toLowerCase();
  return v && (ORDER as readonly string[]).includes(v) ? (v as LogLevel) : null;
}

let sink: (text: string) => void = (text) => void process.stderr.write(text);
let level: LogLevel = parseLogLevel(process.env.ORCH_LOG_LEVEL) ?? "info";

export function setLogLevel(next: LogLevel): void {
  level = next;
}

export function getLogLevel(): LogLevel {
  return level;
}

/** Test seam: redirect diagnostic output; returns the previous sink to restore. */
export function setLogSink(next: (text: string) => void): (text: string) => void {
  const previous = sink;
  sink = next;
  return previous;
}

function enabled(target: LogLevel): boolean {
  return ORDER.indexOf(target) <= ORDER.indexOf(level);
}

function emit(target: LogLevel, prefix: string, message: string): void {
  if (!enabled(target)) return;
  sink(prefix ? `${prefix} ${message}\n` : `${message}\n`);
}

export const log = {
  error: (message: string): void => emit("error", pc.red("error:"), message),
  warn: (message: string): void => emit("warn", pc.yellow("warn:"), message),
  info: (message: string): void => emit("info", "", message),
  debug: (message: string): void => emit("debug", pc.dim("debug:"), message),
};
