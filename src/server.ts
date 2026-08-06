import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Transport } from "./transport.js";
import type { ServerNotificationEnvelope } from "../schemas/ServerNotificationEnvelope.js";

export interface NorvynServer {
  readonly url: string;
  close(): Promise<void>;
}

export async function startNorvyn(workspace: string): Promise<NorvynServer> {
  const token = randomBytes(32).toString("hex");
  const transport = await Transport.connect();
  let thread: Promise<string> | undefined;
  let startingTurn = false;
  const pendingNotifications: ServerNotificationEnvelope[] = [];
  const staticDirectory = findStaticDirectory();
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method !== "GET") {
      response.writeHead(404).end();
      return;
    }

    try {
      const relativePath = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
      const filePath = resolve(staticDirectory, relativePath);
      if (!filePath.startsWith(`${staticDirectory}${sep}`)) throw new Error("Invalid static path");
      const file = await readFile(filePath);
      response.writeHead(200, { "content-type": contentType(filePath), "cache-control": "no-store" });
      response.end(file);
    } catch {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("Norvyn client is unavailable.");
    }
  });

  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/socket" || !matchesToken(requestUrl.searchParams.get("token"), token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    sockets.handleUpgrade(request, socket, head, (connection) => {
      sockets.emit("connection", connection, request);
    });
  });

  sockets.on("connection", (connection) => {
    connection.send(JSON.stringify({ type: "connection", status: "connected", workspace }));
    connection.on("message", async (payload) => {
      const message = JSON.parse(payload.toString()) as { type?: string; text?: string };
      if (message.type !== "turn/start" || !message.text) return;
      startingTurn = true;
      try {
        const currentThread = thread ??= transport.startThread(workspace);
        const threadId = await currentThread;
        const turnId = await transport.startTurn(threadId, message.text);
        connection.send(JSON.stringify({ type: "turn/started", turnId }));
      } finally {
        startingTurn = false;
        for (const notification of pendingNotifications.splice(0)) broadcast(notification);
      }
    });
  });

  transport.on("notification", (message: ServerNotificationEnvelope) => {
    if (startingTurn) { pendingNotifications.push(message); return; }
    broadcast(message);
  });

  function broadcast(message: ServerNotificationEnvelope) {
    const params = message.params as { delta?: string; turn?: { id: string } } | undefined;
    const event = message.method === "item/agentMessage/delta" ? { type: "agent/message/delta", delta: params?.delta } :
      message.method === "turn/completed" ? { type: "turn/completed", turnId: params?.turn?.id } : undefined;
    if (event) for (const connection of sockets.clients) connection.send(JSON.stringify(event));
  }

  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Norvyn could not determine its local address.");

  const url = `http://127.0.0.1:${address.port}/?token=${token}`;
  return { url, close: async () => { transport.close(); await close(server, sockets); } };
}

function findStaticDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const compiledDirectory = join(moduleDirectory, "public");
  return existsSync(compiledDirectory) ? compiledDirectory : resolve(moduleDirectory, "..");
}

function contentType(filePath: string): string {
  const types: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  return types[extname(filePath)] ?? "application/octet-stream";
}

function matchesToken(candidate: string | null, token: string): boolean {
  if (!candidate || candidate.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
}

function listen(server: Server): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

function close(server: Server, sockets: WebSocketServer): Promise<void> {
  for (const connection of sockets.clients) connection.close();
  sockets.close();
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}
