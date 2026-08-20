import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";

const MEMORY_FILE = "AGENTS.md";
const LOG_HEADER = "## Log";

export function memoryPath(cwd: string): string {
  return resolve(cwd, MEMORY_FILE);
}

/**
 * Append a durable fact to the shared memory (AGENTS.md), under a `## Log`
 * section. Appending is a single write (serialized enough for same-machine,
 * low-frequency use); the file is versioned with the repo so both harnesses
 * see it via the CLAUDE.md -> @AGENTS.md redirect.
 */
export function addFact(text: string, type: string, cwd: string): void {
  const p = memoryPath(cwd);
  if (!existsSync(p)) {
    throw new Error(`No ${MEMORY_FILE} found in ${cwd}. Run \`orch init\` first.`);
  }
  const date = new Date().toISOString().slice(0, 10);
  const entry = `- ${date} [${type}] ${text.trim()}\n`;
  const hasHeader = readFileSync(p, "utf8").includes(LOG_HEADER);
  appendFileSync(p, hasHeader ? entry : `\n${LOG_HEADER}\n${entry}`);
}

export function listFacts(cwd: string): string[] {
  const p = memoryPath(cwd);
  if (!existsSync(p)) return [];
  const content = readFileSync(p, "utf8");
  const idx = content.indexOf(LOG_HEADER);
  if (idx < 0) return [];
  return content
    .slice(idx + LOG_HEADER.length)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "));
}
