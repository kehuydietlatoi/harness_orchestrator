import http from "node:http";
import { readFile } from "node:fs/promises";
import { buildSnapshot } from "./snapshot.js";

const dashboardPath = new URL("../public/index.html", import.meta.url);

export function createServer(cwd: string): http.Server {
  return http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

    if (request.method === "GET" && pathname === "/status") {
      void buildSnapshot(cwd)
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

export function startServer(cwd: string, port: number): Promise<http.Server> {
  const server = createServer(cwd);
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}
