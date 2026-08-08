import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { clampPaneWidth, failTurnTranscript, filterThreads, groupThreadsByWorkspace, modelOption, shouldSubmitComposer, visibleGroupThreads, visibleWorkspaces, workspaceName } from "../src/client/main.js";
import { DEFAULT_MODELS } from "../src/models.js";
import { folderPickerLaunch } from "../src/server.js";

const children: ChildProcessWithoutNullStreams[] = [];
const paths: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) { child.kill(); await once(child, "exit"); }
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("history is newest-first, derives Workspaces, and resumes a complete transcript", async () => {
  const app = await launch();
  const history = await app.next("history");
  expect(history.threads.map((thread: any) => thread.id)).toEqual(["history-new", "history-old"]);
  expect(history.workspaces).toEqual(["C:\\workspaces\\alpha", "C:\\workspaces\\beta"]);

  app.send({ type: "chat/open", threadId: "history-new" });
  const opened = await app.next("chat/selected");
  expect(opened.chat).toMatchObject({ threadId: "history-new", workspace: "C:\\workspaces\\alpha", model: DEFAULT_MODELS[0], accessMode: "manual" });
  expect(opened.transcript[0].items.map((item: any) => item.text ?? item.content?.[0]?.text)).toEqual(["Previous question", "Previous answer"]);

  app.send({ type: "turn/start", chatId: "history-new", text: "Continue" });
  expect(await app.next("agent/message/delta")).toMatchObject({ delta: "Hello", threadId: "history-new" });
  app.close();
});

test("default model, reasoning subscription, and the immutable Workspace Boundary reach the Provider", async () => {
  const workspace = await temporaryDirectory("norvyn-boundary-");
  const app = await launch(workspace);
  const connection = await app.next("connection");
  expect(connection.chat).toMatchObject({ workspace, model: DEFAULT_MODELS[0], accessMode: "manual" });
  expect(connection.models).toEqual([...DEFAULT_MODELS]);
  expect(connection.models).not.toContain("hidden-model");
  expect(connection.models.every((model: string) => !model.startsWith("gpt-5.4"))).toBe(true);

  app.send({ type: "turn/start", chatId: connection.chat.id, text: "inspect-boundary" });
  const delta = await app.next("agent/message/delta");
  const received = JSON.parse(delta.delta);
  expect(received.thread).toMatchObject({ cwd: workspace, model: DEFAULT_MODELS[0], approvalPolicy: "on-request", sandbox: "workspace-write" });
  expect(received.thread.config.sandbox_workspace_write).toEqual({ writable_roots: [workspace], network_access: false });
  expect(received.turn).toMatchObject({ model: DEFAULT_MODELS[0], summary: "detailed" });
  app.close();
});

test("a config can add an unknown model and make it usable", async () => {
  const configDirectory = await temporaryDirectory("norvyn-config-");
  const configPath = join(configDirectory, "config.json");
  await writeFile(configPath, JSON.stringify({ models: ["gpt-tomorrow"], defaultModel: "gpt-tomorrow" }));
  const app = await launch(undefined, { NORVYN_CONFIG: configPath });
  const connection = await app.next("connection");
  expect(connection.models).toContain("gpt-tomorrow");
  expect(connection.chat.model).toBe("gpt-tomorrow");
  app.send({ type: "turn/start", chatId: connection.chat.id, text: "inspect-boundary" });
  const received = JSON.parse((await app.next("agent/message/delta")).delta);
  expect(received.turn.model).toBe("gpt-tomorrow");
  app.close();
});

test("a config can replace the compiled model list", async () => {
  const configDirectory = await temporaryDirectory("norvyn-replace-config-");
  const configPath = join(configDirectory, "config.json");
  await writeFile(configPath, JSON.stringify({ modelMode: "replace", models: ["private-model"] }));
  const app = await launch(undefined, { NORVYN_CONFIG: configPath });
  const connection = await app.next("connection");
  expect(connection.models).toEqual(["private-model"]);
  expect(connection.chat.model).toBe("private-model");
  app.close();
});

test("a malformed model config fails startup with a clear message", async () => {
  const configDirectory = await temporaryDirectory("norvyn-bad-config-");
  const configPath = join(configDirectory, "config.json");
  await writeFile(configPath, "{ definitely not json");
  const workspace = await temporaryDirectory("norvyn-workspace-");
  const child = startCli(workspace, { NORVYN_CONFIG: configPath });
  children.push(child);
  const stderr = collect(child.stderr);
  await once(child, "exit");
  expect(await stderr).toContain(`Malformed Norvyn config at ${configPath}`);
});

test("new Chats validate and bind independent Workspaces without restarting", async () => {
  const first = await temporaryDirectory("norvyn-first-");
  const second = await temporaryDirectory("norvyn-second-");
  const app = await launch(first);
  const initial = (await app.next("connection")).chat;
  app.send({ type: "turn/start", chatId: initial.id, text: "Hello" });
  const firstTurn = await app.next("turn/started");

  app.send({ type: "chat/new" });
  const fresh = (await app.next("chat/selected")).chat;
  expect(fresh.workspace).toBeUndefined();
  app.send({ type: "chat/workspace", chatId: fresh.id, workspace: join(second, "missing") });
  expect((await app.next("error")).message).toContain("does not exist");
  app.send({ type: "chat/workspace", chatId: fresh.id, workspace: second });
  expect((await app.next("chat/updated")).chat.workspace).toBe(second);
  app.send({ type: "turn/start", chatId: fresh.id, text: "Hello" });
  const secondTurn = await app.next("turn/started");
  expect(secondTurn.threadId).not.toBe(firstTurn.threadId);
  app.close();
});

describe.each([
  ["manual", ["file-change", "command-execution"]],
  ["auto-edit", ["command-execution"]],
  ["auto", []],
] as const)("Access Mode %s", (mode, forwarded) => {
  test("routes file and command approvals correctly and a decline continues the Turn", async () => {
    const app = await launch();
    const chat = (await app.next("connection")).chat;
    app.send({ type: "chat/access-mode", chatId: chat.id, accessMode: mode });
    await app.next("chat/updated");
    app.send({ type: "turn/start", chatId: chat.id, text: "approvals" });
    const decisions: string[] = [];
    for (const expectedKind of forwarded) {
      const request = await app.next("approval/request");
      expect(request.kind).toBe(expectedKind);
      const approved = expectedKind !== "file-change";
      decisions.push(approved ? "accept" : "decline");
      app.send({ type: "approval/respond", requestId: request.requestId, approved });
    }
    const response = await app.next("agent/message/delta");
    if (mode === "manual") expect(response.delta).toBe("file:decline;command:accept");
    if (mode === "auto-edit") expect(response.delta).toBe("file:accept;command:accept");
    if (mode === "auto") expect(response.delta).toBe("file:accept;command:accept");
    app.close();
  });
});

test("Access Mode remains isolated per Chat and unanswered approvals expire without blocking the connection", async () => {
  const app = await launch(undefined, { NORVYN_APPROVAL_TIMEOUT_MS: "30" });
  const first = (await app.next("connection")).chat;
  app.send({ type: "chat/access-mode", chatId: first.id, accessMode: "auto" });
  expect((await app.next("chat/updated")).chat.accessMode).toBe("auto");
  app.send({ type: "chat/new", workspace: first.workspace });
  const second = (await app.next("chat/selected")).chat;
  expect(second.accessMode).toBe("manual");
  app.send({ type: "turn/start", chatId: second.id, text: "approvals" });
  await app.next("approval/request");
  await app.next("approval/expired");
  const commandApproval = await app.next("approval/request");
  app.send({ type: "approval/respond", requestId: commandApproval.requestId, approved: false });
  expect((await app.next("agent/message/delta")).delta).toBe("file:decline;command:decline");
  app.close();
});

test("reasoning and tool activity stay ordered, compact, and carry full output", async () => {
  const app = await launch();
  const chat = (await app.next("connection")).chat;
  app.send({ type: "turn/start", chatId: chat.id, text: "reasoning-tools" });
  const relevant = await app.nextMany(["reasoning/delta", "tool/activity", "tool/output/delta", "tool/activity", "agent/message/delta"]);
  expect(relevant.map((event) => event.type)).toEqual(["reasoning/delta", "tool/activity", "tool/output/delta", "tool/activity", "agent/message/delta"]);
  expect(relevant[1]).toMatchObject({ status: "in-progress", item: { type: "commandExecution", command: "npm test" } });
  expect(relevant[3]).toMatchObject({ status: "completed", item: { aggregatedOutput: "all green" } });
  app.close();
});

test("stopping a Turn preserves the Chat and allows an immediate next Turn", async () => {
  const app = await launch();
  const chat = (await app.next("connection")).chat;
  app.send({ type: "turn/start", chatId: chat.id, text: "slow" });
  await app.next("turn/started");
  app.send({ type: "turn/interrupt", chatId: chat.id });
  await app.next("turn/interrupted");
  app.send({ type: "turn/start", chatId: chat.id, text: "Next" });
  expect((await app.next("agent/message/delta")).delta).toBe("Hello");
  app.close();
});

test("usage limits are explained with optional reset details and other failures pass through", async () => {
  const app = await launch();
  const chat = (await app.next("connection")).chat;
  app.send({ type: "turn/start", chatId: chat.id, text: "usage-limit" });
  expect((await app.next("turn/error")).message).toBe("You've reached your ChatGPT plan usage limit. Resets at 18:30 UTC.");
  app.send({ type: "turn/start", chatId: chat.id, text: "usage-limit-no-reset" });
  expect((await app.next("turn/error")).message).toBe("You've reached your ChatGPT plan usage limit.");
  app.send({ type: "turn/start", chatId: chat.id, text: "raw-error" });
  expect((await app.next("turn/error")).message).toBe("EXACT_PROVIDER_FAILURE");
  app.close();
});

test("an unsupported ChatGPT model ends the Turn with an actionable error", async () => {
  const app = await launch();
  const chat = (await app.next("connection")).chat;
  app.send({ type: "turn/start", chatId: chat.id, text: "unsupported-model" });
  await app.next("turn/started");
  expect(await app.next("turn/error")).toMatchObject({
    chatId: chat.id,
    terminal: true,
    message: "This model isn't available with your ChatGPT account. Choose another available model and retry.",
  });
  app.close();
});

test("a rejected Provider request never exposes raw JSON in Chat", async () => {
  const app = await launch();
  const chat = (await app.next("connection")).chat;
  app.send({ type: "turn/start", chatId: chat.id, text: "request-json-error" });
  expect((await app.next("error")).message).toBe("Provider rejected this request.");
  app.send({ type: "turn/start", chatId: chat.id, text: "request-malformed-json-error" });
  expect((await app.next("error")).message).toBe("The Provider rejected this request. Check your setup and retry.");
  app.close();
});

test("an unexpected Provider exit fails the in-flight Turn, re-handshakes, and recovers", async () => {
  const app = await launch();
  const chat = (await app.next("connection")).chat;
  app.send({ type: "turn/start", chatId: chat.id, text: "crash" });
  await app.next("turn/started");
  expect((await app.next("turn/failed")).message).toContain("restarting");
  app.send({ type: "turn/start", chatId: chat.id, text: "Recovered" });
  expect((await app.next("agent/message/delta", 4_000)).delta).toBe("Hello");
  app.close();
});

test("repeated restart handshake failures stop with an explicit message", async () => {
  const markerDirectory = await temporaryDirectory("norvyn-marker-");
  const marker = join(markerDirectory, "failed");
  const app = await launch(undefined, { NORVYN_FAKE_MODE: "restart-fails", NORVYN_FAKE_MARKER: marker });
  const chat = (await app.next("connection")).chat;
  app.send({ type: "turn/start", chatId: chat.id, text: "crash" });
  await app.next("turn/failed");
  expect((await app.next("provider/unavailable", 4_000)).message).toContain("after 3 attempts");
  app.close();
});

test("History search and divider resizing enforce the frontend interaction rules", () => {
  const threads = [
    { id: "1", title: "Alpha Chat", preview: "one", workspace: "a", updatedAt: 2, createdAt: 1 },
    { id: "2", title: "Beta Chat", preview: "two", workspace: "b", updatedAt: 1, createdAt: 1 },
  ];
  expect(filterThreads(threads, "alpha").map((thread) => thread.id)).toEqual(["1"]);
  expect(clampPaneWidth(10, 1000)).toBe(220);
  expect(clampPaneWidth(900, 1000)).toBe(580);
  expect(clampPaneWidth(300, 1000)).toBe(300);
});

test("History groups Chats by Workspace while preserving newest-first order", () => {
  const threads = [
    { id: "1", title: "Newest Alpha", preview: "one", workspace: "C:\\workspaces\\alpha", updatedAt: 3, createdAt: 1 },
    { id: "2", title: "Beta", preview: "two", workspace: "C:\\workspaces\\beta", updatedAt: 2, createdAt: 1 },
    { id: "3", title: "Older Alpha", preview: "three", workspace: "C:\\workspaces\\alpha", updatedAt: 1, createdAt: 1 },
  ];
  expect(groupThreadsByWorkspace(threads).map((group) => ({ workspace: group.workspace, ids: group.threads.map((thread) => thread.id) }))).toEqual([
    { workspace: "C:\\workspaces\\alpha", ids: ["1", "3"] },
    { workspace: "C:\\workspaces\\beta", ids: ["2"] },
  ]);
  expect(workspaceName("C:\\workspaces\\alpha")).toBe("alpha");
  expect(workspaceName("/home/norvyn/project")).toBe("project");
  const manyThreads = Array.from({ length: 7 }, (_, index) => ({ ...threads[0], id: String(index) }));
  expect(visibleGroupThreads(manyThreads, false)).toHaveLength(5);
  expect(visibleGroupThreads(manyThreads, true)).toHaveLength(7);
  expect(visibleWorkspaces(["one", "two", "three", "four", "five", "six"])).toEqual(["one", "two", "three", "four", "five"]);
  const folderPicker = folderPickerLaunch("win32");
  expect(folderPicker.command).toBe("powershell.exe");
  expect(folderPicker.args).toEqual(expect.arrayContaining(["-STA", "-Command"]));
  expect(folderPicker.args.at(-1)).toContain("FolderBrowserDialog");
  expect(() => folderPickerLaunch("linux")).toThrow("Windows only");
  expect(modelOption("gpt-5.6-terra")).toMatchObject({ label: "GPT-5.6 Terra", detail: "Balanced" });
  expect(shouldSubmitComposer("Enter", false, false)).toBe(true);
  expect(shouldSubmitComposer("Enter", true, false)).toBe(false);
  expect(shouldSubmitComposer("Enter", false, true)).toBe(false);
  expect(failTurnTranscript([
    { kind: "user", id: "user", text: "Hello" },
    { kind: "assistant", id: "assistant", text: "" },
  ], "Unavailable", "error")).toEqual([
    { kind: "user", id: "user", text: "Hello" },
    { kind: "error", id: "error", text: "Unavailable" },
  ]);
});

test("Workspace History can be archived or permanently deleted without touching Workspace files", async () => {
  const app = await launch();
  await app.next("connection");
  await app.next("history");

  app.send({ type: "history/workspace/archive", workspace: "C:\\workspaces\\alpha" });
  expect(await app.next("history/workspace/removed")).toMatchObject({ action: "archived", count: 1, threadIds: ["history-new"] });
  expect((await app.next("history")).workspaces).toEqual(["C:\\workspaces\\beta"]);

  app.send({ type: "history/workspace/delete", workspace: "C:\\workspaces\\beta" });
  expect(await app.next("history/workspace/removed")).toMatchObject({ action: "deleted", count: 1, threadIds: ["history-old"] });
  expect((await app.next("history")).workspaces).toEqual([]);
  app.close();
});

async function launch(workspace?: string, extraEnv: Record<string, string> = {}) {
  const appWorkspace = workspace ?? await temporaryDirectory("norvyn-workspace-");
  const child = startCli(appWorkspace, extraEnv);
  children.push(child);
  const url = await firstLine(child.stdout);
  const access = new URLSearchParams(new URL(url).hash.slice(1)).get("access");
  if (!access) throw new Error("No Browser bootstrap access.");
  const sessionResponse = await fetch(`${new URL(url).origin}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ access }) });
  const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
  if (!sessionResponse.ok || !cookie) throw new Error("Browser Session was not established.");
  const socketUrl = new URL(url); socketUrl.protocol = "ws:"; socketUrl.pathname = "/socket"; socketUrl.hash = "";
  const socket = new WebSocket(socketUrl, { headers: { cookie } });
  const events: any[] = [];
  const waiters: (() => void)[] = [];
  socket.on("message", (payload) => { events.push(JSON.parse(payload.toString())); for (const wake of waiters.splice(0)) wake(); });
  await once(socket, "open");
  return {
    send(message: unknown) { socket.send(JSON.stringify(message)); },
    close() { socket.close(); },
    async next(type: string, timeout = 2_000): Promise<any> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const index = events.findIndex((event) => event.type === type);
        if (index >= 0) return events.splice(index, 1)[0];
        await wake(waiters, Math.min(100, deadline - Date.now()));
      }
      throw new Error(`Timed out waiting for ${type}; received ${JSON.stringify(events)}`);
    },
    async nextMany(types: string[]): Promise<any[]> {
      const result = [];
      for (const type of types) result.push(await this.next(type));
      return result;
    },
  };
}

function startCli(workspace: string, extraEnv: Record<string, string> = {}): ChildProcessWithoutNullStreams {
  const root = process.cwd();
  return spawn(process.execPath, [join(root, "dist", "cli.js"), "--no-open"], { cwd: workspace, env: { ...process.env, ...extraEnv, NORVYN_PROVIDER_COMMAND: process.execPath, NORVYN_PROVIDER_ARGUMENTS: JSON.stringify([join(root, "test", "fixtures", "fake-provider.mjs")]) }, stdio: ["pipe", "pipe", "pipe"] });
}
async function temporaryDirectory(prefix: string): Promise<string> { const path = await mkdtemp(join(tmpdir(), prefix)); paths.push(path); return path; }
function firstLine(stream: NodeJS.ReadableStream): Promise<string> { return new Promise((resolve, reject) => { let output = ""; const timer = setTimeout(() => reject(new Error("No URL")), 3_000); stream.on("data", (chunk) => { output += chunk; const end = output.indexOf("\n"); if (end >= 0) { clearTimeout(timer); resolve(output.slice(0, end).trim()); } }); stream.once("error", reject); }); }
function collect(stream: NodeJS.ReadableStream): Promise<string> { return new Promise((resolve) => { let output = ""; stream.on("data", (chunk) => output += chunk); stream.on("end", () => resolve(output)); }); }
function wake(waiters: (() => void)[], timeout: number): Promise<void> { return new Promise((resolve) => { const timer = setTimeout(resolve, Math.max(1, timeout)); waiters.push(() => { clearTimeout(timer); resolve(); }); }); }
