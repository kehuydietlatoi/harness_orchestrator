import { loadConfig } from "../config.js";
import { makeDemoDeps } from "../demo.js";
import { startServer } from "../server.js";

export async function serveCommand(opts: { port?: string; demo?: boolean }): Promise<void> {
  const cwd = process.cwd();
  // Demo mode is self-contained (in-memory fixture), so it needs no config/repo.
  if (!opts.demo) loadConfig(cwd);

  const rawPort = opts.port ?? "4000";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid port '${rawPort}' (expected an integer from 1 to 65535)`);
  }

  await startServer(cwd, port, opts.demo ? makeDemoDeps() : undefined);
  console.log(`Dashboard: http://127.0.0.1:${port}`);
  if (opts.demo) {
    console.log("Demo mode: seeded in-memory board — no gh, git, or claude required. Try Suggest routing → Apply.");
  }
}
