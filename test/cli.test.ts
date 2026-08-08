import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import WebSocket from "ws";
import { providerLaunch } from "../src/transport.js";

const runningProcesses: ReturnType<typeof spawn>[] = [];
const temporaryWorkspaces: string[] = [];

afterEach(async () => {
  for (const child of runningProcesses.splice(0)) {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
  }

  await Promise.all(
    temporaryWorkspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })),
  );
});

test("starting Norvyn bootstraps POST-backed browser authorization without query parameters", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "norvyn-workspace-"));
  temporaryWorkspaces.push(workspace);

  const child = startCli(workspace);
  runningProcesses.push(child);

  const url = await firstLine(child.stdout!);

  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#access=[a-f0-9]{64}$/);
  expect(new URL(url).search).toBe("");

  const response = await fetch(url);
  expect(response.status).toBe(200);
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");

  const event = await connect(url);
  expect(event).toMatchObject({ type: "connection", status: "connected", workspace });
});

test("Norvyn refuses WebSocket connections without POST-created browser authorization", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "norvyn-workspace-"));
  temporaryWorkspaces.push(workspace);

  const child = startCli(workspace);
  runningProcesses.push(child);

  const url = await firstLine(child.stdout!);
  await expect(connectSocket(url)).rejects.toThrow("Unexpected server response: 401");
  expect((await createBrowserSession(url, "malformed")).status).toBe(401);
  const cookie = await authorizeBrowser(url);
  expect((await createBrowserSession(url)).status).toBe(401);
  await expect(connectSocket(url, cookie, "https://attacker.example")).rejects.toThrow(
    "Unexpected server response: 401",
  );
  expect((await createBrowserSession(url, accessFrom(url), "https://attacker.example")).status).toBe(403);
  expect((await fetch(`${new URL(url).origin}/session`)).status).toBe(405);
  const queryResponse = await fetch(`${new URL(url).origin}/?access=${accessFrom(url)}`);
  expect(queryResponse.status).toBe(400);
  expect(await queryResponse.text()).not.toContain(accessFrom(url));
});

test("expired Browser bootstrap access is rejected", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "norvyn-workspace-"));
  temporaryWorkspaces.push(workspace);
  const child = startCli(workspace, { NORVYN_SESSION_TTL_MS: "1" });
  runningProcesses.push(child);
  const url = await firstLine(child.stdout!);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect((await createBrowserSession(url)).status).toBe(401);
});

test("a token from an earlier Norvyn run cannot open the next run", async () => {
  const firstWorkspace = await mkdtemp(join(tmpdir(), "norvyn-workspace-"));
  const secondWorkspace = await mkdtemp(join(tmpdir(), "norvyn-workspace-"));
  temporaryWorkspaces.push(firstWorkspace, secondWorkspace);

  const first = startCli(firstWorkspace);
  const firstUrl = await firstLine(first.stdout!);
  first.kill();
  await once(first, "exit");

  const second = startCli(secondWorkspace);
  runningProcesses.push(second);
  const secondUrl = await firstLine(second.stdout!);

  expect(accessFrom(secondUrl)).not.toBe(accessFrom(firstUrl));
  expect((await createBrowserSession(secondUrl, accessFrom(firstUrl))).status).toBe(401);
});

test("stopping Norvyn closes its local server", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "norvyn-workspace-"));
  temporaryWorkspaces.push(workspace);

  const child = startCli(workspace);
  const url = await firstLine(child.stdout!);
  child.kill();
  await once(child, "exit");

  await expect(fetch(url)).rejects.toThrow();
});

test("a Browser Turn creates a Thread and streams the Provider reply", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "norvyn-workspace-"));
  temporaryWorkspaces.push(workspace);
  const child = startCli(workspace);
  runningProcesses.push(child);
  const url = await firstLine(child.stdout!);

  const events = await startTurn(url, "Say hello");

  const turnEvents = events.filter((event: any) =>
    ["turn/started", "agent/message/delta", "turn/completed"].includes(event.type),
  );
  expect(turnEvents.map((event: any) => event.type)).toEqual([
    "turn/started",
    "agent/message/delta",
    "turn/completed",
  ]);
  expect((turnEvents[1] as any).delta).toBe("Hello");
});

test("Norvyn accepts a Local Session status written to stderr by the Codex CLI", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "norvyn-workspace-"));
  temporaryWorkspaces.push(workspace);
  const child = startCli(workspace, { NORVYN_SKIP_PREFLIGHT: undefined });
  runningProcesses.push(child);

  const event = await connect(await firstLine(child.stdout!));

  expect(event).toMatchObject({ type: "connection", status: "connected", workspace });
});

test("Windows starts the Codex app-server through the command launcher", () => {
  expect(providerLaunch({}, "win32")).toEqual({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "codex app-server"],
  });
});

test("Windows rejects shell metacharacters in a configured Codex path", () => {
  expect(() => providerLaunch({}, "win32", "codex&whoami")).toThrow("unsupported command characters");
  expect(() => providerLaunch({}, "win32", "C:\\Program Files\\Codex\\codex.exe")).not.toThrow();
});

test("Browser receives an install step when the Codex CLI is missing", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "norvyn-workspace-"));
  temporaryWorkspaces.push(workspace);
  const child = startCli(workspace, {
    NORVYN_SKIP_PREFLIGHT: undefined,
    NORVYN_PROVIDER_COMMAND: "norvyn-missing-codex",
  });
  runningProcesses.push(child);

  const events = await connectAll(await firstLine(child.stdout!));

  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "connection",
        status: "disconnected",
        providerStatus: "missing",
        workspace,
      }),
      {
        type: "preflight/failed",
        kind: "missing",
        message: "Codex CLI is not installed. Install it with: npm install -g @openai/codex@latest",
      },
    ]),
  );
});

test("Browser receives installed and required versions when the Codex CLI is too old", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "norvyn-workspace-"));
  temporaryWorkspaces.push(workspace);
  const child = startCli(workspace, fakeCodex("old"));
  runningProcesses.push(child);

  const events = await connectAll(await firstLine(child.stdout!));

  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "connection",
        status: "disconnected",
        providerStatus: "failed",
        workspace,
      }),
      {
        type: "preflight/failed",
        kind: "outdated",
        message:
          "Codex CLI 0.1.0 is too old. Norvyn requires 0.146.1, so supported models are unavailable. Update with: npm install -g @openai/codex@latest",
      },
    ]),
  );
});

test("Browser offers Provider-owned sign-in when there is no Local Session", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "norvyn-workspace-"));
  temporaryWorkspaces.push(workspace);
  const child = startCli(workspace, fakeCodex("signed-out"));
  runningProcesses.push(child);

  const events = await connectAll(await firstLine(child.stdout!));

  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "connection",
        status: "disconnected",
        providerStatus: "signed-out",
        workspace,
      }),
      { type: "auth/state", status: "required" },
    ]),
  );
});

test("diagnostics distinguish an expired Provider-owned Local Session", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "norvyn-workspace-"));
  temporaryWorkspaces.push(workspace);
  const child = startCli(workspace, fakeCodex("expired"));
  runningProcesses.push(child);

  const events = await connectAll(await firstLine(child.stdout!));
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "connection", providerStatus: "signed-out" }),
      expect.objectContaining({
        type: "diagnostics/state",
        report: expect.objectContaining({ localSession: "expired" }),
      }),
      { type: "auth/state", status: "required" },
    ]),
  );
});

test("Connect With Codex triggers Provider-owned authentication and enters Chat automatically", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "norvyn-workspace-"));
  const markerDirectory = await mkdtemp(join(tmpdir(), "norvyn-login-"));
  const marker = join(markerDirectory, "connected");
  temporaryWorkspaces.push(workspace, markerDirectory);
  const child = startCli(workspace, {
    NORVYN_SKIP_PREFLIGHT: undefined,
    NORVYN_FAKE_SIGNED_OUT: "1",
    NORVYN_FAKE_LOGIN_MARKER: marker,
  });
  runningProcesses.push(child);
  const app = await connectInteractive(await firstLine(child.stdout!));
  await app.next("auth/state", (event) => event.status === "required");
  app.send({ type: "auth/connect" });
  expect((await app.next("auth/state", (event) => event.status === "connecting")).status).toBe("connecting");
  expect((await app.next("auth/state", (event) => event.status === "connected", 5_000)).status).toBe(
    "connected",
  );
  expect((await app.next("connection", (event) => event.status === "connected")).chat.accessMode).toBe(
    "manual",
  );
  app.close();
});

test.each([
  ["login-fails", "failed"],
  ["login-cancelled", "cancelled"],
  ["login-timeout", "timed-out"],
] as const)("Connect With Codex reports %s through the Provider seam", async (mode, expectedStatus) => {
  const workspace = await mkdtemp(join(tmpdir(), "norvyn-workspace-"));
  temporaryWorkspaces.push(workspace);
  const child = startCli(workspace, {
    ...fakeCodex(mode),
    ...(mode === "login-timeout" ? { NORVYN_LOGIN_TIMEOUT_MS: "25" } : {}),
  });
  runningProcesses.push(child);
  const app = await connectInteractive(await firstLine(child.stdout!));
  await app.next("auth/state", (event) => event.status === "required");
  app.send({ type: "auth/connect" });
  await app.next("auth/state", (event) => event.status === "connecting");
  expect((await app.next("auth/state", (event) => event.status === expectedStatus)).status).toBe(
    expectedStatus,
  );
  app.close();
});

function startCli(workspace: string, environment: NodeJS.ProcessEnv = {}): ReturnType<typeof spawn> {
  const sourceRoot = process.cwd();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NORVYN_SKIP_PREFLIGHT: "1",
    NORVYN_PROVIDER_COMMAND: process.execPath,
    NORVYN_PROVIDER_ARGUMENTS: JSON.stringify([join(sourceRoot, "test", "fixtures", "fake-provider.mjs")]),
    ...environment,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return spawn(process.execPath, [join(sourceRoot, "dist", "cli.js"), "--no-open"], {
    cwd: workspace,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Norvyn did not print its URL")), 2_000);
    let output = "";
    stream.on("data", (chunk) => {
      output += chunk.toString();
      const lineEnd = output.indexOf("\n");
      if (lineEnd >= 0) {
        clearTimeout(timeout);
        resolve(output.slice(0, lineEnd).trim());
      }
    });
    stream.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function connect(httpUrl: string): Promise<unknown> {
  return connectSocket(httpUrl, await authorizeBrowser(httpUrl));
}

function connectSocket(httpUrl: string, cookie?: string, origin = new URL(httpUrl).origin): Promise<unknown> {
  const socketUrl = new URL(httpUrl);
  socketUrl.protocol = "ws:";
  socketUrl.pathname = "/socket";
  socketUrl.hash = "";

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl, { origin, headers: cookie ? { cookie } : undefined });
    socket.once("message", (message) => {
      resolve(JSON.parse(message.toString()));
      socket.close();
    });
    socket.once("error", reject);
  });
}

async function connectAll(httpUrl: string): Promise<unknown[]> {
  const cookie = await authorizeBrowser(httpUrl);
  const socketUrl = new URL(httpUrl);
  socketUrl.protocol = "ws:";
  socketUrl.pathname = "/socket";
  socketUrl.hash = "";
  return new Promise((resolve, reject) => {
    const events: unknown[] = [];
    const socket = new WebSocket(socketUrl, { origin: new URL(httpUrl).origin, headers: { cookie } });
    socket.on("message", (message) => {
      const event = JSON.parse(message.toString());
      events.push(event);
      if (event.type === "preflight/failed" || event.type === "auth/state") {
        socket.close();
        resolve(events);
      }
    });
    socket.once("error", reject);
  });
}

function fakeCodex(
  mode: "old" | "signed-out" | "expired" | "login-fails" | "login-cancelled" | "login-timeout",
): NodeJS.ProcessEnv {
  const sourceRoot = process.cwd();
  return {
    NORVYN_SKIP_PREFLIGHT: undefined,
    NORVYN_PROVIDER_COMMAND: process.execPath,
    NORVYN_PROVIDER_ARGUMENTS: JSON.stringify([join(sourceRoot, "test", "fixtures", "fake-codex.mjs"), mode]),
  };
}

async function startTurn(httpUrl: string, text: string): Promise<unknown[]> {
  const cookie = await authorizeBrowser(httpUrl);
  const socketUrl = new URL(httpUrl);
  socketUrl.protocol = "ws:";
  socketUrl.pathname = "/socket";
  socketUrl.hash = "";
  return new Promise((resolve, reject) => {
    const events: unknown[] = [];
    const socket = new WebSocket(socketUrl, { origin: new URL(httpUrl).origin, headers: { cookie } });
    socket.on("message", (message) => {
      const event = JSON.parse(message.toString());
      if (event.type === "connection") socket.send(JSON.stringify({ type: "turn/start", text }));
      else if (event.type !== "history") {
        events.push(event);
        if (event.type === "turn/completed") {
          socket.close();
          resolve(events);
        }
      }
    });
    socket.once("error", reject);
  });
}

async function connectInteractive(httpUrl: string) {
  const cookie = await authorizeBrowser(httpUrl);
  const socketUrl = new URL(httpUrl);
  socketUrl.protocol = "ws:";
  socketUrl.pathname = "/socket";
  socketUrl.hash = "";
  const socket = new WebSocket(socketUrl, { origin: new URL(httpUrl).origin, headers: { cookie } });
  const events: any[] = [];
  const waiters: (() => void)[] = [];
  socket.on("message", (message) => {
    events.push(JSON.parse(message.toString()));
    for (const wake of waiters.splice(0)) wake();
  });
  await once(socket, "open");
  return {
    send(message: unknown) {
      socket.send(JSON.stringify(message));
    },
    close() {
      socket.close();
    },
    async next(type: string, predicate: (event: any) => boolean = () => true, timeout = 2_000): Promise<any> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const index = events.findIndex((event) => event.type === type && predicate(event));
        if (index >= 0) return events.splice(index, 1)[0];
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 50);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      throw new Error(`Timed out waiting for ${type}; received ${JSON.stringify(events)}`);
    },
  };
}

function accessFrom(httpUrl: string): string {
  const access = new URLSearchParams(new URL(httpUrl).hash.slice(1)).get("access");
  if (!access) throw new Error("Norvyn did not provide Browser bootstrap access.");
  return access;
}

function createBrowserSession(
  httpUrl: string,
  access = accessFrom(httpUrl),
  origin = new URL(httpUrl).origin,
): Promise<Response> {
  return fetch(`${new URL(httpUrl).origin}/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ access }),
  });
}

async function authorizeBrowser(httpUrl: string): Promise<string> {
  const response = await createBrowserSession(httpUrl);
  if (!response.ok) throw new Error(`Browser Session failed: ${response.status}`);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Browser Session cookie was not issued.");
  return cookie;
}
