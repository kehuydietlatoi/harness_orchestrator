import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * Harness logs are appended to, never truncated (`spawnLogged` opens them with the append flag), and
 * a retry within the same round reuses the same file. Anything that judges a run by its log (a usage
 * limit, a failure cause) must therefore read only what *that run* wrote, or it will rediscover a
 * previous attempt's events and misjudge the new one.
 */

/** Current size of a log in bytes; 0 when it does not exist yet. Take this just before a run. */
export function logSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** The text appended to `file` after byte `offset` (empty when the file is missing or unchanged). */
export function readLogSince(file: string, offset: number): string {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return "";
  }
  try {
    const length = statSync(file).size - offset;
    if (length <= 0) return "";
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, offset);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}
