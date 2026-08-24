import { type AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, isLoopback, startServer, type ServerDeps } from "../src/server.js";
import type { OrchConfig } from "../src/config.js";
import type { Issue } from "../src/github.js";

vi.mock("../src/snapshot.js", () => ({
  buildSnapshot: vi.fn(async () => ({
    generatedAt: "2026-08-23T12:00:00.000Z",
    tasks: [],
    reviewQueue: [],
  })),
}));

interface ResponseView {
  status: number | undefined;
  contentType: string | undefined;
  body: string;
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function request(port: number, path: string): Promise<ResponseView> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          contentType: response.headers["content-type"],
          body,
        }),
      );
    });
    request.on("error", reject);
    request.end();
  });
}

function post(port: number, path: string, body?: unknown): Promise<ResponseView> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = payload
      ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
      : {};
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers }, (response) => {
      let received = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (received += chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode, contentType: response.headers["content-type"], body: received }),
      );
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function issue(number: number, labels: string[] = []): Issue {
  return { number, title: `Task ${number}`, body: "", state: "OPEN", labels, assignees: [] };
}

function fakeDeps(over: Partial<ServerDeps> = {}): {
  deps: ServerDeps;
  edits: Array<{ n: number; labels: string[] }>;
} {
  const edits: Array<{ n: number; labels: string[] }> = [];
  const deps: ServerDeps = {
    loadConfig: () => ({ agents: ["claude", "codex"] }) as OrchConfig,
    listOpenIssues: async () => [issue(1), issue(2, ["agent:claude"])],
    readRuns: () => [],
    runJudge: async () => [{ issue: 1, agent: "codex", effort: "easy", rationale: "mechanical" }],
    editIssue: async (n, labels) => {
      edits.push({ n, labels });
    },
    ...over,
  };
  return { deps, edits };
}

describe("dashboard server", () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    const running = servers.splice(0);
    await Promise.all(
      running.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  it("serves the board snapshot as JSON", async () => {
    const server = createServer(process.cwd());
    servers.push(server);
    const port = await listen(server);
    const response = await request(port, "/status");

    expect(response.status).toBe(200);
    expect(response.contentType).toMatch(/^application\/json\b/);
    expect(JSON.parse(response.body)).toMatchObject({ tasks: [] });
  });

  it("returns 404 for an unknown route", async () => {
    const server = createServer(process.cwd());
    servers.push(server);
    const port = await listen(server);
    const { status } = await request(port, "/unknown");

    expect(status).toBe(404);
  });

  it("serves the self-contained dashboard page", async () => {
    const server = createServer(process.cwd());
    servers.push(server);
    const port = await listen(server);
    const response = await request(port, "/");

    expect(response.status).toBe(200);
    expect(response.contentType).toMatch(/^text\/html\b/);
    expect(response.body).toContain("Orch dashboard");
  });

  it("starts on the IPv4 localhost interface only", async () => {
    const server = await startServer(process.cwd(), 0);
    servers.push(server);

    const address = server.address() as AddressInfo;
    expect(address.address).toBe("127.0.0.1");
    expect(address.family).toBe("IPv4");
  });
});

describe("isLoopback", () => {
  it("accepts loopback addresses and rejects everything else", () => {
    for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(isLoopback(addr)).toBe(true);
    for (const addr of ["10.0.0.5", "192.168.1.9", "::ffff:10.0.0.5", undefined]) {
      expect(isLoopback(addr)).toBe(false);
    }
  });
});

describe("write surface", () => {
  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(async () => {
    const running = servers.splice(0);
    await Promise.all(running.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  });
  const start = async (deps: ServerDeps): Promise<number> => {
    const server = createServer(process.cwd(), deps);
    servers.push(server);
    return listen(server);
  };

  it("POST /actions/suggest returns the judge's suggestions and writes nothing", async () => {
    const { deps, edits } = fakeDeps();
    const port = await start(deps);
    const res = await post(port, "/actions/suggest");

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      suggestions: [{ issue: 1, agent: "codex", effort: "easy", rationale: "mechanical" }],
    });
    expect(edits).toHaveLength(0);
  });

  it("POST /actions/suggest returns 502 and writes nothing when the judge fails", async () => {
    const { deps, edits } = fakeDeps({
      runJudge: async () => {
        throw new Error("unparseable judge output");
      },
    });
    const port = await start(deps);
    const res = await post(port, "/actions/suggest");

    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).error).toMatch(/unparseable/);
    expect(edits).toHaveLength(0);
  });

  it("POST /actions/assign with origin brain writes labels + assigned-by:brain and skips pins", async () => {
    const { deps, edits } = fakeDeps();
    const port = await start(deps);
    const res = await post(port, "/actions/assign", {
      origin: "brain",
      plan: [
        { issue: 1, agent: "codex", effort: "easy" },
        { issue: 2, agent: "codex", effort: "hard" },
      ],
    });

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.writes).toEqual([{ issue: 1, agent: "codex", effort: "easy" }]);
    expect(parsed.skips).toEqual([{ issue: 2, reason: "already pinned" }]);
    expect(edits).toEqual([{ n: 1, labels: ["agent:codex", "effort:easy", "assigned-by:brain"] }]);
  });

  it("POST /actions/assign with origin human omits the brain label", async () => {
    const { deps, edits } = fakeDeps();
    const port = await start(deps);
    await post(port, "/actions/assign", { origin: "human", plan: [{ issue: 1, agent: "claude", effort: "hard" }] });

    expect(edits).toEqual([{ n: 1, labels: ["agent:claude", "effort:hard"] }]);
  });

  it("POST /actions/assign rejects a malformed body with 400 and no writes", async () => {
    const { deps, edits } = fakeDeps();
    const port = await start(deps);
    const res = await post(port, "/actions/assign", { plan: "not-an-array" });

    expect(res.status).toBe(400);
    expect(edits).toHaveLength(0);
  });

  it("returns 404 for an unknown action", async () => {
    const { deps } = fakeDeps();
    const port = await start(deps);
    const res = await post(port, "/actions/nope", {});
    expect(res.status).toBe(404);
  });
});
