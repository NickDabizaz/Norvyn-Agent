import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import WebSocket from "ws";

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

function startCli(workspace: string): ReturnType<typeof spawn> {
  const sourceRoot = process.cwd();
  return spawn(process.execPath, [join(sourceRoot, "dist", "cli.js"), "--no-open"], {
    cwd: workspace,
    env: { ...process.env, NORVYN_PROVIDER_COMMAND: process.execPath, NORVYN_PROVIDER_ARGUMENTS: JSON.stringify([join(sourceRoot, "test", "fixtures", "fake-provider.mjs")]) },
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
