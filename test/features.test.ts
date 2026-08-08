import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { clampPaneWidth } from "../src/client/app-shell.js";
import { shouldSubmitComposer } from "../src/client/composer.js";
import { appendReasoningDelta, failTurnTranscript } from "../src/client/conversation.js";
import {
  filterThreads,
  groupThreadsByWorkspace,
  modelOption,
  visibleGroupThreads,
  visibleWorkspaces,
  workspaceName,
} from "../src/client/sidebar.js";
import { folderPickerLaunch } from "../src/features/workspace-picker.js";

const PROVIDER_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;
const children: ChildProcessWithoutNullStreams[] = [];
const paths: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("history is newest-first, derives Workspaces, and resumes a complete transcript", async () => {
  const app = await launch();
  const history = await app.next("history/page");
  expect(history.threads.map((thread: any) => thread.id)).toEqual(["history-new", "history-old"]);
  expect(history.workspaces).toEqual(["C:\\workspaces\\alpha", "C:\\workspaces\\beta"]);

  app.send({ type: "chat/open", threadId: "history-new" });
  const opened = await app.next("chat/selected");
  expect(opened.chat).toMatchObject({
    threadId: "history-new",
    workspace: "C:\\workspaces\\alpha",
    model: PROVIDER_MODELS[0],
    accessMode: "manual",
  });
  expect(opened.transcript[0].items.map((item: any) => item.text ?? item.content?.[0]?.text)).toEqual([
    "Previous question",
    "Previous answer",
  ]);

  app.send({ type: "turn/start", chatId: "history-new", text: "Continue" });
  expect(await app.next("agent/message/delta")).toMatchObject({ delta: "Hello", threadId: "history-new" });
  app.close();
});

test("default model, reasoning subscription, and the immutable Workspace Boundary reach the Provider", async () => {
  const workspace = await temporaryDirectory("norvyn-boundary-");
  const app = await launch(workspace);
  const connection = await app.next("connection");
  expect(connection.chat).toMatchObject({ workspace, model: PROVIDER_MODELS[0], accessMode: "manual" });
  expect(connection.models).toEqual([...PROVIDER_MODELS]);
  expect(connection.workspaceBrowseAvailable).toBe(process.platform === "win32");
  expect(connection.models).not.toContain("hidden-model");
  expect(connection.models.every((model: string) => !model.startsWith("gpt-5.4"))).toBe(true);

  app.send({ type: "chat/effort", chatId: connection.chat.id, effort: "high" });
  await app.next("chat/updated");
  app.send({
    type: "turn/start",
    chatId: connection.chat.id,
    text: "inspect-boundary",
    attachments: [
      { kind: "image", name: "proof.png", mimeType: "image/png", dataUrl: "data:image/png;base64,YQ==" },
      { kind: "text", name: "notes.md", mimeType: "text/markdown", text: "ground truth" },
    ],
  });
  const delta = await app.next("agent/message/delta");
  const received = JSON.parse(delta.delta);
  expect(received.thread).toMatchObject({
    cwd: workspace,
    model: PROVIDER_MODELS[0],
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  expect(received.thread.config.sandbox_workspace_write).toEqual({
    writable_roots: [workspace],
    network_access: false,
  });
  expect(received.turn).toMatchObject({ model: PROVIDER_MODELS[0], effort: "high", summary: "detailed" });
  expect(received.turn.input).toEqual([
    { type: "text", text: "inspect-boundary", text_elements: [] },
    { type: "image", url: "data:image/png;base64,YQ==" },
    expect.objectContaining({ type: "text", text: expect.stringContaining("ground truth") }),
  ]);
  app.close();
});

test("legacy custom models are selectable only when the Provider advertises them", async () => {
  const configDirectory = await temporaryDirectory("norvyn-config-");
  const configPath = join(configDirectory, "config.json");
  await writeFile(configPath, JSON.stringify({ models: ["gpt-tomorrow"], defaultModel: "gpt-tomorrow" }));
  const app = await launch(undefined, { NORVYN_CONFIG: configPath });
  const connection = await app.next("connection");
  expect(connection.models).not.toContain("gpt-tomorrow");
  expect(connection.chat.model).toBe(PROVIDER_MODELS[0]);
  app.send({ type: "turn/start", chatId: connection.chat.id, text: "inspect-boundary" });
  const received = JSON.parse((await app.next("agent/message/delta")).delta);
  expect(received.turn.model).toBe(PROVIDER_MODELS[0]);
  app.close();
});

test("a legacy replacement catalog cannot make unsupported models selectable", async () => {
  const configDirectory = await temporaryDirectory("norvyn-replace-config-");
  const configPath = join(configDirectory, "config.json");
  await writeFile(configPath, JSON.stringify({ modelMode: "replace", models: ["private-model"] }));
  const app = await launch(undefined, { NORVYN_CONFIG: configPath });
  const connection = await app.next("connection");
  expect(connection.models).toEqual([...PROVIDER_MODELS]);
  expect(connection.chat.model).toBe(PROVIDER_MODELS[0]);
  app.close();
});

test("a malformed settings file keeps Norvyn usable and reports an actionable warning", async () => {
  const configDirectory = await temporaryDirectory("norvyn-bad-config-");
  const configPath = join(configDirectory, "config.json");
  await writeFile(configPath, "{ definitely not json");
  const app = await launch(undefined, { NORVYN_CONFIG: configPath });
  expect((await app.next("connection")).status).toBe("connected");
  expect((await app.next("settings/state")).warning).toContain(`Fix or replace ${configPath}`);
  app.close();
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
  expect(await app.next("operation/error")).toMatchObject({
    scope: "workspace",
    code: "workspace.operation-failed",
    message: expect.stringContaining("does not exist"),
    recovery: "choose-workspace",
  });
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
    expect(await app.next("turn/completed")).not.toHaveProperty("turn");
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
  const relevant = await app.nextMany([
    "reasoning/delta",
    "tool/activity",
    "tool/output/delta",
    "tool/activity",
    "agent/message/delta",
  ]);
  expect(relevant.map((event) => event.type)).toEqual([
    "reasoning/delta",
    "tool/activity",
    "tool/output/delta",
    "tool/activity",
    "agent/message/delta",
  ]);
  expect(relevant[1]).toMatchObject({
    status: "in-progress",
    item: { type: "commandExecution", command: "npm test" },
  });
  expect(relevant[3]).toMatchObject({ status: "completed", item: { aggregatedOutput: "all green" } });
  app.close();
});

test("streaming reasoning is inserted before the pending assistant response", () => {
  const entries = appendReasoningDelta(
    [
      { kind: "user", id: "user", text: "Question", complete: true },
      { kind: "assistant", id: "assistant", text: "", complete: false },
    ],
    "reasoning",
    "Thinking first",
  );
  expect(entries.map((entry) => entry.kind)).toEqual(["user", "reasoning", "assistant"]);
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

test("usage limits are explained while unexpected Provider failures are sanitized", async () => {
  const app = await launch();
  const chat = (await app.next("connection")).chat;
  app.send({ type: "turn/start", chatId: chat.id, text: "usage-limit" });
  expect((await app.next("turn/error")).message).toBe(
    "You've reached your ChatGPT plan usage limit. Resets at 18:30 UTC.",
  );
  app.send({ type: "turn/start", chatId: chat.id, text: "usage-limit-no-reset" });
  expect((await app.next("turn/error")).message).toBe("You've reached your ChatGPT plan usage limit.");
  app.send({ type: "turn/start", chatId: chat.id, text: "raw-error" });
  expect((await app.next("turn/error")).message).toBe(
    "The Provider reported an unexpected Turn failure. Retry the Turn or reconnect the Provider.",
  );
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
    message:
      "This model isn't available with your ChatGPT account. Choose another available model and retry.",
  });
  app.close();
});

test("a rejected Provider request never exposes raw JSON in Chat", async () => {
  const app = await launch();
  const chat = (await app.next("connection")).chat;
  app.send({ type: "turn/start", chatId: chat.id, text: "request-json-error" });
  expect((await app.next("operation/error")).message).toBe(
    "The Provider rejected this request. Check your setup and retry.",
  );
  app.send({ type: "turn/start", chatId: chat.id, text: "request-malformed-json-error" });
  expect((await app.next("operation/error")).message).toBe(
    "The Provider rejected this request. Check your setup and retry.",
  );
  app.close();
});

test("a malformed Provider response rejects only its request and leaves the connection usable", async () => {
  const app = await launch();
  const chat = (await app.next("connection")).chat;
  app.send({ type: "turn/start", chatId: chat.id, text: "malformed-provider-response" });
  expect(await app.next("operation/error")).toMatchObject({
    scope: "turn",
    code: "turn.operation-failed",
    message: "The Provider rejected this request. Check your setup and retry.",
  });
  app.send({ type: "turn/start", chatId: chat.id, text: "invalid-json-provider-response" });
  expect(await app.next("operation/error")).toMatchObject({
    scope: "turn",
    message: "The Provider rejected this request. Check your setup and retry.",
  });
  app.send({ type: "turn/start", chatId: chat.id, text: "still connected" });
  expect((await app.next("agent/message/delta")).delta).toBe("Hello");
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
  let providerState;
  do providerState = await app.next("provider/state", 4_000);
  while (providerState.status !== "failed");
  expect(providerState.message).toContain("after 3 attempts");
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
    {
      id: "1",
      title: "Newest Alpha",
      preview: "one",
      workspace: "C:\\workspaces\\alpha",
      updatedAt: 3,
      createdAt: 1,
    },
    { id: "2", title: "Beta", preview: "two", workspace: "C:\\workspaces\\beta", updatedAt: 2, createdAt: 1 },
    {
      id: "3",
      title: "Older Alpha",
      preview: "three",
      workspace: "C:\\workspaces\\alpha",
      updatedAt: 1,
      createdAt: 1,
    },
  ];
  expect(
    groupThreadsByWorkspace(threads).map((group) => ({
      workspace: group.workspace,
      ids: group.threads.map((thread) => thread.id),
    })),
  ).toEqual([
    { workspace: "C:\\workspaces\\alpha", ids: ["1", "3"] },
    { workspace: "C:\\workspaces\\beta", ids: ["2"] },
  ]);
  expect(workspaceName("C:\\workspaces\\alpha")).toBe("alpha");
  expect(workspaceName("/home/norvyn/project")).toBe("project");
  const manyThreads = Array.from({ length: 7 }, (_, index) => ({ ...threads[0], id: String(index) }));
  expect(visibleGroupThreads(manyThreads, false)).toHaveLength(5);
  expect(visibleGroupThreads(manyThreads, true)).toHaveLength(7);
  expect(visibleWorkspaces(["one", "two", "three", "four", "five", "six"])).toEqual([
    "one",
    "two",
    "three",
    "four",
    "five",
  ]);
  const folderPicker = folderPickerLaunch("win32");
  expect(folderPicker.command).toBe("powershell.exe");
  expect(folderPicker.args).toEqual(expect.arrayContaining(["-STA", "-Command"]));
  expect(folderPicker.args.at(-1)).toContain("FolderBrowserDialog");
  expect(() => folderPickerLaunch("linux")).toThrow("unavailable on this platform");
  expect(modelOption("gpt-5.6-terra")).toMatchObject({ label: "GPT-5.6 Terra", detail: "Balanced" });
  expect(shouldSubmitComposer("Enter", false, false)).toBe(true);
  expect(shouldSubmitComposer("Enter", true, false)).toBe(false);
  expect(shouldSubmitComposer("Enter", false, true)).toBe(false);
  expect(
    failTurnTranscript(
      [
        { kind: "user", id: "user", text: "Hello" },
        { kind: "assistant", id: "assistant", text: "" },
      ],
      "Unavailable",
      "error",
    ),
  ).toEqual([
    { kind: "user", id: "user", text: "Hello" },
    { kind: "error", id: "error", text: "Unavailable" },
  ]);
});

test("Workspace History can be archived or permanently deleted without touching Workspace files", async () => {
  const app = await launch();
  await app.next("connection");
  await app.next("history/page");

  app.send({ type: "history/workspace/archive", workspace: "C:\\workspaces\\alpha" });
  expect(await app.next("history/workspace/removed")).toMatchObject({
    action: "archived",
    count: 1,
    threadIds: ["history-new"],
  });
  expect((await app.next("history/page")).workspaces).toEqual(["C:\\workspaces\\beta"]);

  app.send({ type: "history/workspace/delete", workspace: "C:\\workspaces\\beta", confirmed: true });
  expect(await app.next("history/workspace/removed")).toMatchObject({
    action: "deleted",
    count: 1,
    threadIds: ["history-old"],
  });
  expect((await app.next("history/page")).workspaces).toEqual([]);
  app.close();
});

test("unsupported protocol messages and unconfirmed destructive commands are rejected", async () => {
  const app = await launch();
  await app.next("connection");
  app.send({ type: "unknown/command" });
  expect(await app.next("operation/error")).toMatchObject({
    scope: "protocol",
    code: "protocol.unknown-type",
    message: "The browser sent an unsupported operation.",
  });
  app.send({ type: "chat/access-mode", chatId: "new-1", accessMode: "unsafe" });
  expect(await app.next("operation/error")).toMatchObject({
    scope: "protocol",
    code: "protocol.invalid-field",
  });
  app.sendRaw("{");
  expect(await app.next("operation/error")).toMatchObject({
    scope: "protocol",
    code: "protocol.invalid-json",
  });
  app.send({ type: "turn/start" });
  expect(await app.next("operation/error")).toMatchObject({
    scope: "protocol",
    code: "protocol.invalid-field",
  });
  app.send({ type: "history/workspace/archive", workspace: "C:\\missing-workspace" });
  expect(await app.next("operation/error")).toMatchObject({ scope: "workspace-history" });
  app.send({ type: "thread/delete", threadId: "history-new", confirmed: false });
  expect(await app.next("operation/error")).toMatchObject({
    scope: "protocol",
    code: "protocol.invalid-field",
    recovery: "retry",
  });
  app.send({ type: "history/list" });
  expect((await app.next("history/page")).threads.length).toBeGreaterThan(0);
  app.close();
});

test("Chat rename, pin, archive, restore, and delete all flow through Provider capabilities", async () => {
  const app = await launch();
  await app.next("connection");
  await app.next("history/page");

  app.send({ type: "thread/rename", threadId: "history-new", name: "Renamed Architecture" });
  expect(await app.next("history/changed")).toMatchObject({ threadId: "history-new", action: "renamed" });
  expect(
    (await app.next("history/page")).threads.find((thread: any) => thread.id === "history-new").title,
  ).toBe("Renamed Architecture");

  app.send({ type: "thread/pin", threadId: "history-old", pinned: true });
  expect((await app.next("history/changed")).action).toBe("pinned");
  const pinnedPage = await app.next("history/page");
  expect(pinnedPage.threads[0]).toMatchObject({ id: "history-old", pinned: true });

  app.send({ type: "thread/archive", threadId: "history-new" });
  expect((await app.next("history/changed")).action).toBe("archived");
  expect((await app.next("history/page")).threads.map((thread: any) => thread.id)).not.toContain(
    "history-new",
  );
  app.send({ type: "history/list", archived: true });
  expect((await app.next("history/page")).threads.map((thread: any) => thread.id)).toContain("history-new");

  app.send({ type: "thread/restore", threadId: "history-new" });
  expect((await app.next("history/changed")).action).toBe("restored");
  await app.next("history/page");

  app.send({ type: "thread/delete", threadId: "history-new", confirmed: true });
  expect((await app.next("history/changed")).action).toBe("deleted");
  expect((await app.next("history/page")).threads.map((thread: any) => thread.id)).not.toContain(
    "history-new",
  );
  app.close();
});

test("Provider-originated Thread notifications refresh open History", async () => {
  const app = await launch();
  await app.next("connection");
  await app.next("history/page");
  app.send({ type: "chat/open", threadId: "history-new" });
  const chat = (await app.next("chat/selected")).chat;
  app.send({ type: "turn/start", chatId: chat.id, text: "external-rename" });
  const refreshed = await app.next("history/page");
  expect(refreshed.threads.find((thread: any) => thread.id === "history-new").title).toBe(
    "Provider renamed Chat",
  );
  app.close();
});

test("large History is paged incrementally without refetching prior pages", async () => {
  const app = await launch(undefined, { NORVYN_FAKE_HISTORY_COUNT: "2500" });
  await app.next("connection");
  const first = await app.next("history/page");
  expect(first.threads).toHaveLength(50);
  expect(first.nextCursor).toBeTruthy();
  app.send({ type: "history/list", cursor: first.nextCursor });
  const second = await app.next("history/page");
  expect(second.threads).toHaveLength(50);
  expect(new Set([...first.threads, ...second.threads].map((thread: any) => thread.id)).size).toBe(100);
  app.close();
});

test("Settings persist valid preferences, reject unsupported models, and reconnect without deleting History", async () => {
  const configDirectory = await temporaryDirectory("norvyn-settings-");
  const configPath = join(configDirectory, "settings.json");
  const app = await launch(undefined, { NORVYN_CONFIG: configPath });
  await app.next("connection");
  const current = (await app.next("settings/state")).settings;
  app.send({
    type: "settings/save",
    settings: {
      ...current,
      defaultModel: "gpt-5.6-terra",
      customModels: ["gpt-5.6-terra"],
      textScale: "large",
      transcriptDensity: "compact",
    },
  });
  const saved = await app.next("settings/saved");
  expect(saved.models).toEqual([...PROVIDER_MODELS]);
  expect(saved.unverifiedModels).toEqual([]);
  expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
    defaultModel: "gpt-5.6-terra",
    textScale: "large",
    transcriptDensity: "compact",
  });

  app.send({
    type: "settings/save",
    settings: { ...saved.settings, defaultModel: "unsupported-model", customModels: [] },
  });
  expect((await app.next("settings/error")).message).toContain("Provider-verified");
  expect(JSON.parse(await readFile(configPath, "utf8")).defaultModel).toBe("gpt-5.6-terra");

  app.send({ type: "provider/disconnect" });
  expect((await app.next("provider/state")).status).toBe("disconnected");
  app.send({ type: "provider/reconnect" });
  let state;
  do state = await app.next("provider/state", 4_000);
  while (state.status !== "connected");
  const history = await app.next("history/page");
  expect(history.threads.map((thread: any) => thread.id)).toEqual(
    expect.arrayContaining(["history-new", "history-old"]),
  );
  app.send({ type: "chat/new" });
  expect((await app.next("chat/selected")).chat.accessMode).toBe("manual");
  app.close();
});

test("Provider model discovery never falls back, refreshes stale catalogs, and marks custom overrides", async () => {
  const directory = await temporaryDirectory("norvyn-models-");
  const modelFile = join(directory, "models.json");
  const configPath = join(directory, "settings.json");
  await writeFile(modelFile, JSON.stringify(["gpt-5.6-terra"]));
  const app = await launch(undefined, { NORVYN_FAKE_MODEL_FILE: modelFile, NORVYN_CONFIG: configPath });
  const connected = await app.next("connection");
  expect(connected.models).toEqual(["gpt-5.6-terra"]);
  expect(connected.chat.model).toBe("gpt-5.6-terra");

  await writeFile(modelFile, JSON.stringify(["gpt-5.6-luna"]));
  app.send({ type: "provider/reconnect" });
  let refreshed;
  do refreshed = await app.next("settings/state", 8_000);
  while (!refreshed.models.includes("gpt-5.6-luna"));
  expect(refreshed.models).toEqual(["gpt-5.6-luna"]);
  expect(refreshed.models).not.toContain("gpt-5.6-terra");

  app.send({ type: "chat/open", threadId: "history-new" });
  const resumed = await app.next("chat/selected");
  expect(resumed.chat.model).toBeUndefined();
  expect(resumed.chat.modelNotice).toContain("no longer advertises");

  app.send({
    type: "settings/save",
    settings: { ...refreshed.settings, customModels: ["custom-preview"], defaultModel: "custom-preview" },
  });
  const custom = await app.next("settings/saved");
  expect(custom.models).toEqual(["gpt-5.6-luna"]);
  expect(custom.unverifiedModels).toEqual(["custom-preview"]);
  app.send({ type: "chat/model", chatId: resumed.chat.id, model: "custom-preview" });
  await app.next("chat/updated");
  app.send({ type: "turn/start", chatId: resumed.chat.id, text: "test custom" });
  expect((await app.next("operation/error")).message).toContain("Provider-verified model");
  app.close();

  for (const mode of ["empty", "fails"]) {
    const unavailable = await launch(undefined, { NORVYN_FAKE_MODEL_MODE: mode });
    const state = await unavailable.next("connection");
    expect(state.models).toEqual([]);
    expect(state.chat.model).toBeUndefined();
    expect(state.modelError).toMatch(/no supported models|discovery failed/i);
    expect(state.modelError).not.toContain("secret");
    unavailable.close();
  }
}, 20_000);

test("first-Turn retry and mid-Chat branching preserve Provider-owned original History", async () => {
  const app = await launch();
  await app.next("connection");
  app.send({ type: "chat/open", threadId: "history-new" });
  const original = await app.next("chat/selected");
  expect(original.transcript).toHaveLength(1);

  app.send({ type: "chat/branch", chatId: original.chat.id, turnId: "past-turn", label: "Mid-Chat branch" });
  const midBranch = await app.next("chat/branched");
  expect(midBranch.chat).toMatchObject({
    origin: { threadId: "history-new", turnId: "past-turn", label: "Mid-Chat branch" },
  });
  expect(midBranch.transcript).toHaveLength(1);

  app.send({ type: "chat/open", threadId: "history-new" });
  const reopened = await app.next("chat/selected");
  app.send({
    type: "chat/branch",
    chatId: reopened.chat.id,
    text: "request-json-error",
    label: "Retried first Turn",
  });
  expect((await app.next("chat/branched")).chat.threadId).not.toBe("history-new");
  expect((await app.next("operation/error")).message).toBe(
    "The Provider rejected this request. Check your setup and retry.",
  );

  app.send({ type: "chat/open", threadId: "history-new" });
  const preserved = await app.next("chat/selected");
  expect(preserved.transcript[0].items[0].content[0].text).toBe("Previous question");
  app.close();
});

test("branching an active Turn requires an explicit stop-or-wait state", async () => {
  const app = await launch();
  const chat = (await app.next("connection")).chat;
  app.send({ type: "turn/start", chatId: chat.id, text: "slow" });
  await app.next("turn/started");
  app.send({ type: "chat/branch", chatId: chat.id, label: "Ambiguous branch" });
  expect((await app.next("operation/error")).message).toContain("Stop the active Turn or wait");
  app.send({ type: "turn/interrupt", chatId: chat.id });
  await app.next("turn/interrupted");
  app.close();
});

test("diagnostics stay available and Provider restart fails an active Turn before recovering", async () => {
  const app = await launch();
  const chat = (await app.next("connection")).chat;
  const report = (await app.next("diagnostics/state")).report;
  expect(report).toMatchObject({
    norvynVersion: "0.1.0",
    localSession: "available",
    providerProcess: "connected",
    connection: "connected",
  });
  app.send({ type: "turn/start", chatId: chat.id, text: "slow" });
  await app.next("turn/started");
  app.send({ type: "provider/restart" });
  expect((await app.next("turn/failed")).message).toContain("restarting");
  let provider;
  do provider = await app.next("provider/state", 4_000);
  while (provider.status !== "connected");
  app.send({ type: "diagnostics/export" });
  const exported = await app.next("diagnostics/export");
  expect(exported.content).not.toMatch(/launchToken|credential|password/i);
  app.close();
});

test("WebSocket reconnection restores the selected active Chat without replaying its Turn", async () => {
  const app = await launch();
  const chat = (await app.next("connection")).chat;
  app.send({ type: "turn/start", chatId: chat.id, text: "slow", requestId: "only-once" });
  const started = await app.next("turn/started");
  await app.reconnect();
  const restored = await app.next("connection");
  expect(restored.chat).toMatchObject({ id: chat.id, threadId: started.threadId, turnId: started.turnId });
  app.send({ type: "turn/interrupt", chatId: chat.id });
  await app.next("turn/interrupted");
  app.close();
});

async function launch(workspace?: string, extraEnv: Record<string, string> = {}) {
  const appWorkspace = workspace ?? (await temporaryDirectory("norvyn-workspace-"));
  const child = startCli(appWorkspace, extraEnv);
  children.push(child);
  const url = await firstLine(child.stdout);
  const access = new URLSearchParams(new URL(url).hash.slice(1)).get("access");
  if (!access) throw new Error("No Browser bootstrap access.");
  const sessionResponse = await fetch(`${new URL(url).origin}/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(url).origin },
    body: JSON.stringify({ access }),
  });
  const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
  if (!sessionResponse.ok || !cookie) throw new Error("Browser Session was not established.");
  const socketUrl = new URL(url);
  socketUrl.protocol = "ws:";
  socketUrl.pathname = "/socket";
  socketUrl.hash = "";
  let socket: WebSocket;
  const events: any[] = [];
  const waiters: (() => void)[] = [];
  async function openSocket() {
    socket = new WebSocket(socketUrl, { origin: new URL(url).origin, headers: { cookie } });
    socket.on("message", (payload) => {
      events.push(JSON.parse(payload.toString()));
      for (const wake of waiters.splice(0)) wake();
    });
    await once(socket, "open");
  }
  await openSocket();
  return {
    send(message: unknown) {
      socket.send(JSON.stringify(message));
    },
    sendRaw(payload: string) {
      socket.send(payload);
    },
    close() {
      socket.close();
    },
    async reconnect() {
      const closed = once(socket, "close");
      socket.close();
      await closed;
      events.splice(0);
      await openSocket();
    },
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
  return spawn(process.execPath, [join(root, "dist", "cli.js"), "--no-open"], {
    cwd: workspace,
    env: {
      ...process.env,
      ...extraEnv,
      NORVYN_PROVIDER_COMMAND: process.execPath,
      NORVYN_PROVIDER_ARGUMENTS: JSON.stringify([join(root, "test", "fixtures", "fake-provider.mjs")]),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}
async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  paths.push(path);
  return path;
}
function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("No URL")), 3_000);
    stream.on("data", (chunk) => {
      output += chunk;
      const end = output.indexOf("\n");
      if (end >= 0) {
        clearTimeout(timer);
        resolve(output.slice(0, end).trim());
      }
    });
    stream.once("error", reject);
  });
}
function wake(waiters: (() => void)[], timeout: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(1, timeout));
    waiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
