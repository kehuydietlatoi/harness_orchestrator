import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { OrchConfig } from "../src/config.js";
import { createServer, type ServerDeps } from "../src/server/server.js";

function deps(createIssues: ServerDeps["createIssues"]): ServerDeps {
  return {
    loadConfig: () => ({ agents: ["codex"] }) as OrchConfig,
    listOpenIssues: async () => [],
    readRuns: () => [],
    runJudge: async () => [],
    editIssue: async () => undefined,
    createIssues,
    snapshot: async () => ({ generatedAt: "2026-08-27T00:00:00.000Z", tasks: [], reviewQueue: [] }),
  };
}

async function post(server: ReturnType<typeof createServer>, body: unknown) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const payload = JSON.stringify(body);
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/actions/plan-create",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "X-Orch-Request": "dashboard",
          Origin: `http://127.0.0.1:${port}`,
        },
      },
      (response) => {
        let received = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (received += chunk));
        response.on("end", () => resolve({ status: response.statusCode, body: received }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("dashboard plan creation results", () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it("returns created, reused, and failed tickets together", async () => {
    const server = createServer(
      process.cwd(),
      deps(async () => ({
        created: [{ id: "a", number: 10, title: "A" }],
        reused: [{ id: "b", number: 11, title: "B" }],
        failed: [{ id: "c", title: "C", error: "GitHub unavailable" }],
      })),
    );
    servers.push(server);

    const response = await post(server, [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
      { id: "c", title: "C" },
    ]);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      created: [{ id: "a", number: 10, title: "A" }],
      reused: [{ id: "b", number: 11, title: "B" }],
      failed: [{ id: "c", title: "C", error: "GitHub unavailable" }],
    });
  });
});
