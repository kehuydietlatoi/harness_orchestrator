import { type AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, startServer } from "../src/server.js";

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
