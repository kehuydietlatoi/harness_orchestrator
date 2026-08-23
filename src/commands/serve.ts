import { loadConfig } from "../config.js";
import { startServer } from "../server.js";

export async function serveCommand(opts: { port?: string }): Promise<void> {
  const cwd = process.cwd();
  loadConfig(cwd);

  const rawPort = opts.port ?? "4000";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid port '${rawPort}' (expected an integer from 1 to 65535)`);
  }

  await startServer(cwd, port);
  console.log(`Dashboard: http://127.0.0.1:${port}`);
}
