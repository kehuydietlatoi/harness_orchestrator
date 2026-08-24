import http from "node:http";
import { readFile } from "node:fs/promises";
import { applyPlan, formatBrief, rollupTelemetry, selectUnassigned, type PlanEntry } from "./assign.js";
import { loadConfig, type OrchConfig } from "./config.js";
import { editIssue, listIssues, type Issue } from "./github.js";
import { runJudge } from "./judge.js";
import { agentLabel, effortLabel, ASSIGNED_BY_BRAIN } from "./labels.js";
import { buildSnapshot, type Snapshot } from "./snapshot.js";
import { readRuns } from "./telemetry.js";

const dashboardPath = new URL("../public/index.html", import.meta.url);
const BODY_LIMIT = 1_000_000; // 1 MB cap on POST bodies

/**
 * Injection seam for the write surface — defaults hit the real modules; tests
 * pass fakes so the HTTP path is exercised without spawning `claude` or `gh`.
 */
export interface ServerDeps {
  loadConfig: (cwd: string) => OrchConfig;
  listOpenIssues: (cwd: string) => Promise<Issue[]>;
  readRuns: (cwd: string) => ReturnType<typeof readRuns>;
  runJudge: (brief: string, cfg: OrchConfig, cwd: string) => Promise<PlanEntry[]>;
  editIssue: (n: number, labels: string[], cwd: string) => Promise<void>;
  /** Board projection for `GET /status`; overridable so `--demo` can serve a fixture. */
  snapshot: (cwd: string) => Promise<Snapshot>;
}

const defaultDeps: ServerDeps = {
  loadConfig,
  listOpenIssues: (cwd) => listIssues({ cwd, state: "open" }),
  readRuns,
  runJudge,
  editIssue: (n, labels, cwd) => editIssue(n, { cwd, addLabels: labels }).then(() => undefined),
  snapshot: buildSnapshot,
};

/** Loopback-only guard. The machine's OS boundary is the sole authz today; a
 * future tunnel MUST add a token check here before exposing writes off-box. */
export function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function sendJson(response: http.ServerResponse, code: number, body: unknown): void {
  response.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

interface AssignBody {
  plan: PlanEntry[];
  origin: "brain" | "human";
}

/** Parse and shape the /actions/assign body; throws on anything malformed. */
function parseAssignBody(raw: string): AssignBody {
  const value: unknown = JSON.parse(raw || "null");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("body must be a JSON object");
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.plan)) throw new Error("body.plan must be an array");
  const plan = obj.plan.map((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`plan entry ${i + 1} must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (!Number.isInteger(e.issue)) throw new Error(`plan entry ${i + 1} needs an integer issue`);
    return {
      issue: e.issue as number,
      agent: typeof e.agent === "string" ? e.agent : String(e.agent),
      effort: typeof e.effort === "string" ? e.effort : String(e.effort),
    };
  });
  const origin = obj.origin === "brain" ? "brain" : "human";
  return { plan, origin };
}

async function handleSuggest(
  cwd: string,
  deps: ServerDeps,
  response: http.ServerResponse,
): Promise<void> {
  const cfg = deps.loadConfig(cwd);
  const issues = await deps.listOpenIssues(cwd);
  if (selectUnassigned(issues).length === 0) {
    sendJson(response, 200, { suggestions: [] }); // nothing to route — skip the judge
    return;
  }
  const brief = formatBrief(issues, rollupTelemetry(deps.readRuns(cwd), cfg.agents));
  let suggestions: PlanEntry[];
  try {
    suggestions = await deps.runJudge(brief, cfg, cwd); // fail-closed: writes nothing
  } catch (error) {
    sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  sendJson(response, 200, { suggestions });
}

async function handleAssign(
  cwd: string,
  deps: ServerDeps,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  let body: AssignBody;
  try {
    body = parseAssignBody(await readBody(request));
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const cfg = deps.loadConfig(cwd);
  const issues = await deps.listOpenIssues(cwd);
  const result = applyPlan(body.plan, issues, cfg);
  for (const write of result.writes) {
    const labels = [agentLabel(write.agent), effortLabel(write.effort)];
    if (body.origin === "brain") labels.push(ASSIGNED_BY_BRAIN);
    await deps.editIssue(write.issue, labels, cwd);
  }
  sendJson(response, 200, { writes: result.writes, skips: result.skips });
}

export function createServer(cwd: string, deps: ServerDeps = defaultDeps): http.Server {
  return http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

    // --- Write surface: loopback-only, the only routes that mutate the board ---
    if (request.method === "POST" && pathname.startsWith("/actions/")) {
      if (!isLoopback(request.socket.remoteAddress)) {
        sendJson(response, 403, { error: "forbidden: local requests only" });
        return;
      }
      const handler =
        pathname === "/actions/suggest"
          ? handleSuggest(cwd, deps, response)
          : pathname === "/actions/assign"
            ? handleAssign(cwd, deps, request, response)
            : null;
      if (!handler) {
        sendJson(response, 404, { error: "unknown action" });
        return;
      }
      void handler.catch((error: unknown) => {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      });
      return;
    }

    if (request.method === "GET" && pathname === "/status") {
      void deps.snapshot(cwd)
        .then((snapshot) => {
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify(snapshot));
        })
        .catch((error: unknown) => {
          response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        });
      return;
    }

    if (request.method === "GET" && pathname === "/") {
      void readFile(dashboardPath)
        .then((body) => {
          response.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
          });
          response.end(body);
        })
        .catch((error: unknown) => {
          response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          response.end(error instanceof Error ? error.message : String(error));
        });
      return;
    }

    response.statusCode = 404;
    response.end();
  });
}

export function startServer(cwd: string, port: number, deps: ServerDeps = defaultDeps): Promise<http.Server> {
  const server = createServer(cwd, deps);
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}
