import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

export const detachedFixture = fileURLToPath(new URL("../fixtures/detached-child/parent.mjs", import.meta.url));

export async function assertStopped(record: string): Promise<void> {
  const { pid, port } = JSON.parse(readFileSync(record, "utf8"));
  expect(() => process.kill(pid, 0), `PID ${pid} survived the run`).toThrow();
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close(err => err ? reject(err) : resolve()));
  });
}

export function cleanupDetached(record: string): void {
  try { process.kill(JSON.parse(readFileSync(record, "utf8")).pid, "SIGKILL"); } catch { /* already stopped */ }
}
