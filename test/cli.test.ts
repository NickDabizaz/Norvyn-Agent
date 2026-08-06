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

  await Promise.all(temporaryWorkspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
});

test("starting Norvyn opens a token-gated local server for the launched Workspace", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "norvyn-workspace-"));
  temporaryWorkspaces.push(workspace);

  const child = startCli(workspace);
  runningProcesses.push(child);

  const url = await firstLine(child.stdout!);

  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]{64}$/);

  const response = await fetch(url);
  expect(response.status).toBe(200);

  const event = await connect(url);
  expect(event).toEqual({ type: "connection", status: "connected", workspace });
});

test("Norvyn refuses WebSocket connections without the current token", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "norvyn-workspace-"));
  temporaryWorkspaces.push(workspace);

  const child = startCli(workspace);
  runningProcesses.push(child);

  const url = await firstLine(child.stdout!);
  const rejectedUrl = new URL(url);
  rejectedUrl.searchParams.set("token", "malformed");

  await expect(connect(rejectedUrl.toString())).rejects.toThrow("Unexpected server response: 401");
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

  expect(new URL(secondUrl).searchParams.get("token")).not.toBe(new URL(firstUrl).searchParams.get("token"));

  const staleUrl = new URL(secondUrl);
  staleUrl.searchParams.set("token", new URL(firstUrl).searchParams.get("token")!);
  await expect(connect(staleUrl.toString())).rejects.toThrow("Unexpected server response: 401");
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

  expect(events).toEqual([
    { type: "turn/started", turnId: "turn-thread-1" },
    { type: "agent/message/delta", delta: "Hello" },
    { type: "turn/completed", turnId: "turn-thread-1" },
  ]);
});

test("Norvyn accepts a Local Session status written to stderr by the Codex CLI", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "norvyn-workspace-"));
  temporaryWorkspaces.push(workspace);
  const child = startCli(workspace, { NORVYN_SKIP_PREFLIGHT: undefined });
  runningProcesses.push(child);

  const event = await connect(await firstLine(child.stdout!));

  expect(event).toEqual({ type: "connection", status: "connected", workspace });
});

test("Windows starts the Codex app-server through the command launcher", () => {
  expect(providerLaunch({}, "win32")).toEqual({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "codex app-server"],
  });
});

test("Browser receives an install step when the Codex CLI is missing", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "norvyn-workspace-"));
  temporaryWorkspaces.push(workspace);
  const child = startCli(workspace, { NORVYN_SKIP_PREFLIGHT: undefined, NORVYN_PROVIDER_COMMAND: "norvyn-missing-codex" });
  runningProcesses.push(child);

  const events = await connectAll(await firstLine(child.stdout!));

  expect(events).toEqual(expect.arrayContaining([
    { type: "connection", status: "disconnected", workspace },
    { type: "preflight/failed", message: "Codex CLI is not installed. Install it with: npm install -g @openai/codex@latest" },
  ]));
});

test("Browser receives installed and required versions when the Codex CLI is too old", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "norvyn-workspace-"));
  temporaryWorkspaces.push(workspace);
  const child = startCli(workspace, fakeCodex("old"));
  runningProcesses.push(child);

  const events = await connectAll(await firstLine(child.stdout!));

  expect(events).toEqual([
    { type: "connection", status: "disconnected", workspace },
    { type: "preflight/failed", message: "Codex CLI 0.1.0 is too old. Norvyn requires 0.146.1, so supported models are unavailable. Update with: npm install -g @openai/codex@latest" },
  ]);
});

test("Browser tells the user to run codex login when there is no Local Session", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "norvyn-workspace-"));
  temporaryWorkspaces.push(workspace);
  const child = startCli(workspace, fakeCodex("signed-out"));
  runningProcesses.push(child);

  const events = await connectAll(await firstLine(child.stdout!));

  expect(events).toEqual([
    { type: "connection", status: "disconnected", workspace },
    { type: "preflight/failed", message: "No Local Session was found. Sign in with: codex login" },
  ]);
});

function startCli(workspace: string, environment: NodeJS.ProcessEnv = {}): ReturnType<typeof spawn> {
  const sourceRoot = process.cwd();
  const env: NodeJS.ProcessEnv = { ...process.env, NORVYN_SKIP_PREFLIGHT: "1", NORVYN_PROVIDER_COMMAND: process.execPath, NORVYN_PROVIDER_ARGUMENTS: JSON.stringify([join(sourceRoot, "test", "fixtures", "fake-provider.mjs")]), ...environment };
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

function connect(httpUrl: string): Promise<unknown> {
  const socketUrl = new URL(httpUrl);
  socketUrl.protocol = "ws:";
  socketUrl.pathname = "/socket";

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    socket.once("message", (message) => {
      resolve(JSON.parse(message.toString()));
      socket.close();
    });
    socket.once("error", reject);
  });
}

function connectAll(httpUrl: string): Promise<unknown[]> {
  const socketUrl = new URL(httpUrl);
  socketUrl.protocol = "ws:";
  socketUrl.pathname = "/socket";
  return new Promise((resolve, reject) => {
    const events: unknown[] = [];
    const socket = new WebSocket(socketUrl);
    socket.on("message", (message) => {
      events.push(JSON.parse(message.toString()));
      if (events.length === 2) { socket.close(); resolve(events); }
    });
    socket.once("error", reject);
  });
}

function fakeCodex(mode: "old" | "signed-out"): NodeJS.ProcessEnv {
  const sourceRoot = process.cwd();
  return {
    NORVYN_SKIP_PREFLIGHT: undefined,
    NORVYN_PROVIDER_COMMAND: process.execPath,
    NORVYN_PROVIDER_ARGUMENTS: JSON.stringify([join(sourceRoot, "test", "fixtures", "fake-codex.mjs"), mode]),
  };
}

function startTurn(httpUrl: string, text: string): Promise<unknown[]> {
  const socketUrl = new URL(httpUrl);
  socketUrl.protocol = "ws:";
  socketUrl.pathname = "/socket";
  return new Promise((resolve, reject) => {
    const events: unknown[] = [];
    const socket = new WebSocket(socketUrl);
    socket.on("message", (message) => {
      const event = JSON.parse(message.toString());
      if (event.type === "connection") socket.send(JSON.stringify({ type: "turn/start", text }));
      else {
        events.push(event);
        if (event.type === "turn/completed") { socket.close(); resolve(events); }
      }
    });
    socket.once("error", reject);
  });
}
