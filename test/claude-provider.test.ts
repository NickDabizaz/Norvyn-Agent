import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import WebSocket from "ws";
import { decodeClaudeEvents } from "../src/claude-codec.js";
import { claudeLaunch, CLAUDE_MODELS } from "../src/claude-transport.js";
import { parseAuthStatus } from "../src/claude-preflight.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

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

test("the Claude Local Session is read from the Provider's own status, never from a credential", () => {
  expect(parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai"}')).toMatchObject({ loggedIn: true });
  expect(parseAuthStatus('Checking...\n{"loggedIn":false}\n')).toMatchObject({ loggedIn: false });
  expect(parseAuthStatus("not json at all")).toBeUndefined();
});

test("the Claude launch carries the Workspace-bound session, Access Mode, model, and Reasoning Effort", () => {
  const { args } = claudeLaunch(
    {
      claudePath: "claude",
      permissionMode: "manual",
      model: "claude-opus-5",
      effort: "minimal",
      threadId: "thread-uuid",
      resume: false,
    },
    {},
    "linux",
  );
  expect(args).toContain("--print");
  expect(args.join(" ")).toContain("--input-format stream-json");
  expect(args.join(" ")).toContain("--output-format stream-json");
  expect(args.join(" ")).toContain("--permission-mode manual");
  expect(args.join(" ")).toContain("--model claude-opus-5");
  // Norvyn's lowest Reasoning Effort has no Claude equivalent, so it maps down to the nearest level.
  expect(args.join(" ")).toContain("--effort low");
  expect(args.join(" ")).toContain("--session-id thread-uuid");

  const resumed = claudeLaunch(
    {
      claudePath: "claude",
      permissionMode: "acceptEdits",
      model: "claude-opus-5",
      effort: "high",
      threadId: "thread-uuid",
      resume: true,
    },
    {},
    "linux",
  );
  expect(resumed.args.join(" ")).toContain("--resume thread-uuid");
  expect(resumed.args).not.toContain("--session-id");
});

test("one Provider line can carry reasoning, text, tool calls, and results; anything else decodes to nothing", () => {
  expect(
    decodeClaudeEvents({
      type: "assistant",
      message: {
        id: "msg_1",
        content: [
          { type: "thinking", thinking: "Considering." },
          { type: "text", text: "Answer" },
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } },
        ],
      },
    }),
  ).toEqual([
    { kind: "reasoning", itemId: "msg_1:0", text: "Considering." },
    { kind: "text", itemId: "msg_1:1", text: "Answer" },
    { kind: "toolStarted", call: { id: "tool-1", tool: "Bash", arguments: { command: "ls" } } },
  ]);

  expect(
    decodeClaudeEvents({
      type: "user",
      message: { id: "msg_2", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] },
    }),
  ).toEqual([{ kind: "toolResult", id: "tool-1", output: "ok", success: true }]);

  expect(decodeClaudeEvents({ type: "result", subtype: "success", is_error: false })).toEqual([
    { kind: "result", error: undefined },
  ]);
  expect(decodeClaudeEvents({ type: "system", subtype: "init" })).toEqual([]);
  expect(decodeClaudeEvents({ type: "rate_limit_event" })).toEqual([]);
  expect(decodeClaudeEvents("not an object")).toEqual([]);
});

test("the Claude Provider streams a Turn, records History in Norvyn's own index, and declines branching", async () => {
  const app = await launch();
  const connection = await app.next("connection");

  expect(connection.models).toEqual([...CLAUDE_MODELS]);
  // Claude Code cannot fork a Thread at a chosen Turn, so branching is advertised as unsupported.
  expect(connection.capabilities).toMatchObject({ branch: false, rename: true, pin: true });

  app.send({ type: "turn/start", chatId: connection.chat.id, text: "Hello" });
  expect(await app.next("reasoning/delta")).toMatchObject({ delta: "Checked the Workspace." });
  expect(await app.next("agent/message/delta")).toMatchObject({ delta: `Hello from ${CLAUDE_MODELS[0]}` });
  await app.next("turn/completed");

  app.send({ type: "history/list" });
  // The Thread is indexed when it starts and its preview lands with the first user message.
  const history = await app.next("history/page", (page) => Boolean(page.threads[0]?.preview));
  expect(history.threads).toHaveLength(1);
  expect(history.threads[0]).toMatchObject({ preview: "Hello", pinned: false, archived: false });

  app.send({ type: "thread/rename", threadId: history.threads[0].id, name: "Renamed Chat" });
  expect(await app.next("history/changed")).toMatchObject({ action: "renamed" });

  app.send({ type: "chat/branch", chatId: connection.chat.id, label: "Branch" });
  expect(await app.next("operation/error")).toMatchObject({
    message: "This Provider does not support Chat branching.",
  });
  app.close();
});

test("Claude tool calls reach the browser as tool activity, and a failed result fails the Turn", async () => {
  const app = await launch();
  const connection = await app.next("connection");

  app.send({ type: "turn/start", chatId: connection.chat.id, text: "claude-tools" });
  expect(await app.next("tool/activity")).toMatchObject({
    status: "in-progress",
    item: { type: "dynamicToolCall", tool: "Bash" },
  });
  expect(await app.next("tool/activity")).toMatchObject({
    status: "completed",
    item: { type: "dynamicToolCall", tool: "Bash", success: true },
  });
  await app.next("turn/completed");

  app.send({ type: "turn/start", chatId: connection.chat.id, text: "claude-error" });
  expect(await app.next("turn/error")).toMatchObject({ terminal: true });
  app.close();
});

test("the Claude Transport binds each Thread's process to its Workspace and its own session id", async () => {
  const workspace = await temporaryDirectory("norvyn-claude-workspace-");
  const app = await launch(workspace);
  const connection = await app.next("connection");

  app.send({ type: "turn/start", chatId: connection.chat.id, text: "claude-inspect" });
  const delta = await app.next("agent/message/delta");
  const launched = JSON.parse(delta.delta) as { args: string[]; cwd: string };

  expect(launched.cwd).toBe(workspace);
  const sessionId = launched.args[launched.args.indexOf("--session-id") + 1];
  app.send({ type: "history/list" });
  const history = await app.next("history/page", (page) => page.threads.length > 0);
  expect(history.threads[0]).toMatchObject({ id: sessionId, workspace });
  app.close();
});

async function launch(workspace?: string) {
  const root = process.cwd();
  const appWorkspace = workspace ?? (await temporaryDirectory("norvyn-claude-workspace-"));
  const configDirectory = await temporaryDirectory("norvyn-claude-config-");
  const config = join(configDirectory, "config.json");
  await writeFile(
    config,
    JSON.stringify({ ...DEFAULT_SETTINGS, provider: "anthropic", defaultModel: CLAUDE_MODELS[0] }),
  );

  const child = spawn(process.execPath, [join(root, "dist", "cli.js"), "--no-open"], {
    cwd: appWorkspace,
    env: {
      ...process.env,
      NORVYN_CONFIG: config,
      NORVYN_THREAD_INDEX: join(configDirectory, "threads.json"),
      NORVYN_CLAUDE_COMMAND: process.execPath,
      NORVYN_CLAUDE_ARGUMENTS: JSON.stringify([join(root, "test", "fixtures", "fake-claude.mjs")]),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
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
  const events: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  const socket = new WebSocket(socketUrl, { origin: new URL(url).origin, headers: { cookie } });
  socket.on("message", (payload) => {
    events.push(JSON.parse(payload.toString()) as Record<string, unknown>);
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
    /**
     * History is also broadcast unprompted as Threads change, so `where` lets a test wait for the
     * page it means rather than whichever one arrived first.
     */
    async next(type: string, where: (event: any) => boolean = () => true, timeout = 5_000): Promise<any> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const index = events.findIndex((event) => event.type === type && where(event));
        if (index >= 0) return events.splice(index, 1)[0];
        await settle(waiters, Math.min(100, deadline - Date.now()));
      }
      throw new Error(`Timed out waiting for ${type}; received ${JSON.stringify(events)}`);
    },
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  paths.push(path);
  return path;
}

function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("No URL")), 5_000);
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

function settle(waiters: (() => void)[], timeout: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(1, timeout));
    waiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
