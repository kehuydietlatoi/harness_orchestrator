import http from "node:http";
import { readFile } from "node:fs/promises";
import { applyPlan, formatBrief, rollupTelemetry, selectUnassigned, type PlanEntry } from "../routing/assign.js";
import { loadConfig, type OrchConfig } from "../config.js";
import { editIssue, ensureLabels, listIssues, type Issue } from "../github/github.js";
import { runJudge } from "../routing/judge.js";
import { agentLabel, effortLabel, labelDefs, ASSIGNED_BY_BRAIN } from "../github/labels.js";
import { buildSnapshot, type Snapshot } from "../board/snapshot.js";
import { readRuns } from "../board/telemetry.js";
import { parseTickets, resolvePlan, type Ticket } from "../tasks/plan.js";
import { createFromPlan, type PlanCreateResult } from "../tasks/plan-create.js";
import { dispatchSpecific } from "../tasks/runner.js";

// Repo-root public/ asset. This file sits at src/server/ (dev) or dist/server/
// (build); "../../public" resolves to <repo>/public in both, since src and dist
// are siblings under the repo root.
const dashboardPath = new URL("../../public/index.html", import.meta.url);
const BODY_LIMIT = 1_000_000; // 1 MB cap on POST bodies
const ORCH_REQUEST_HEADER = "x-orch-request";
const ORCH_REQUEST_VALUE = "dashboard";

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
  /** Create issues from a ticket draft (`POST /actions/plan-create`); overridable for --demo/tests. */
  createIssues: (tickets: Ticket[], cwd: string) => Promise<PlanCreateResult>;
  /** Board projection for `GET /status`; overridable so `--demo` can serve a fixture. */
  snapshot: (cwd: string) => Promise<Snapshot>;
  /** Claim and run one routed todo; invoked after the dispatch response has ended. */
  dispatchIssue: (issue: number, cwd: string) => Promise<unknown>;
}

const defaultDeps: ServerDeps = {
  loadConfig,
  listOpenIssues: (cwd) => listIssues({ cwd, state: "open" }),
  readRuns,
  runJudge,
  editIssue: (n, labels, cwd) =>
    ensureLabels(labelDefs(labels), cwd) // self-heal: create routing labels a stale repo lacks
      .then(() => editIssue(n, { cwd, addLabels: labels }))
      .then(() => undefined),
  createIssues: createFromPlan,
  snapshot: buildSnapshot,
  dispatchIssue: (issue, cwd) => dispatchSpecific(issue, loadConfig(cwd), cwd),
};

/** Socket-level half of the dashboard write guard. */
export function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

interface RequestRejection {
  status: 403 | 415;
  error: string;
}

/** Parse a Host header as an HTTP origin and require a literal loopback name
 * plus the port that accepted this connection. Matching localPort closes the
 * door on a syntactically trusted Host header for some other local service. */
function localHostOrigin(request: http.IncomingMessage): string | null {
  const host = request.headers.host;
  const localPort = request.socket.localPort;
  if (!host || !localPort) return null;

  try {
    const parsed = new URL(`http://${host}`);
    const hostname = parsed.hostname.toLowerCase();
    const port = parsed.port === "" ? 80 : Number(parsed.port);
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(hostname) ||
      port !== localPort
    ) {
      return null;
    }
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** Browser-facing authorization for every action. The custom header forces a
 * cross-origin browser to preflight; Host and Origin then independently block
 * DNS rebinding and ordinary CSRF. This must run before choosing a handler so
 * no injected dependency or request body is touched for a rejected request. */
function rejectActionRequest(request: http.IncomingMessage): RequestRejection | null {
  if (!isLoopback(request.socket.remoteAddress)) {
    return { status: 403, error: "forbidden: local requests only" };
  }

  const hostOrigin = localHostOrigin(request);
  if (!hostOrigin) return { status: 403, error: "forbidden: invalid Host" };

  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin.toLowerCase() !== hostOrigin) {
    return { status: 403, error: "forbidden: invalid Origin" };
  }

  if (request.headers[ORCH_REQUEST_HEADER] !== ORCH_REQUEST_VALUE) {
    return { status: 403, error: `forbidden: missing ${ORCH_REQUEST_HEADER}` };
  }

  const contentType = request.headers["content-type"];
  const mediaType = typeof contentType === "string" ? contentType.split(";", 1)[0]?.trim().toLowerCase() : null;
  if (mediaType !== "application/json") {
    return { status: 415, error: "unsupported media type: application/json required" };
  }

  return null;
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

/** Preview a ticket draft: parse + validate, return the resolved plan. Writes nothing. */
async function handlePlanPreview(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  let tickets: Ticket[];
  try {
    tickets = parseTickets(await readBody(request));
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  sendJson(response, 200, resolvePlan(tickets)); // { tickets, errors, warnings }
}

/** Create issues from a ticket draft — the second mutating route. Refuses (400) on
 * blocking validation errors so a bad draft never half-creates a board. */
async function handlePlanCreate(
  cwd: string,
  deps: ServerDeps,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  let tickets: Ticket[];
  try {
    tickets = parseTickets(await readBody(request));
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const { errors } = resolvePlan(tickets);
  if (errors.length) {
    sendJson(response, 400, { error: `invalid tickets: ${errors.join("; ")}`, errors });
    return;
  }
  const result = await deps.createIssues(tickets, cwd);
  sendJson(response, 200, result);
}

/** Accept a targeted run and start it on the next event-loop turn so the HTTP
 * request never waits for claim setup or the long-lived agent process. */
async function handleDispatch(
  cwd: string,
  deps: ServerDeps,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  let issue: number;
  try {
    const value: unknown = JSON.parse((await readBody(request)) || "null");
    const candidate = value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).issue
      : undefined;
    if (!Number.isInteger(candidate) || (candidate as number) < 1) {
      throw new Error("body.issue must be a positive integer");
    }
    issue = candidate as number;
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  sendJson(response, 202, { accepted: true, issue });
  setImmediate(() => {
    void deps.dispatchIssue(issue, cwd).catch((error: unknown) => {
      console.error(`dispatch #${issue} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
}

export function createServer(cwd: string, deps: ServerDeps = defaultDeps): http.Server {
  return http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

    // --- Write surface: locally authorized actions; includes the only mutations ---
    if (request.method === "POST" && pathname.startsWith("/actions/")) {
      const rejection = rejectActionRequest(request);
      if (rejection) {
        sendJson(response, rejection.status, { error: rejection.error });
        return;
      }
      const handler =
        pathname === "/actions/suggest"
          ? handleSuggest(cwd, deps, response)
          : pathname === "/actions/assign"
            ? handleAssign(cwd, deps, request, response)
            : pathname === "/actions/plan-preview"
              ? handlePlanPreview(request, response)
              : pathname === "/actions/plan-create"
                ? handlePlanCreate(cwd, deps, request, response)
                : pathname === "/actions/dispatch"
                  ? handleDispatch(cwd, deps, request, response)
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
