import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { CodexAdapter, type ThreadOrganizer, type ThreadStore, type Transport } from "./transport.js";
import { loadModelCatalog } from "./models.js";
import { checkPreflight } from "./preflight.js";
import type { ServerNotificationEnvelope } from "../schemas/ServerNotificationEnvelope.js";
import type { ServerRequest } from "../schemas/ServerRequest.js";
import type { Thread } from "../schemas/v2/Thread.js";
import type { ThreadItem } from "../schemas/v2/ThreadItem.js";
import type { TurnError } from "../schemas/v2/TurnError.js";

export interface NorvynServer { readonly url: string; close(): Promise<void> }
export type AccessMode = "manual" | "auto-edit" | "auto";

interface ChatState {
  id: string;
  threadId?: string;
  workspace?: string;
  model: string;
  accessMode: AccessMode;
  turnId?: string;
}

type BrowserMessage =
  | { type: "history/list"; search?: string }
  | { type: "chat/new"; workspace?: string }
  | { type: "chat/open"; threadId: string }
  | { type: "chat/workspace"; chatId: string; workspace: string }
  | { type: "chat/workspace/browse"; chatId: string }
  | { type: "chat/model"; chatId: string; model: string }
  | { type: "chat/access-mode"; chatId: string; accessMode: AccessMode }
  | { type: "history/workspace/archive"; workspace: string }
  | { type: "history/workspace/delete"; workspace: string }
  | { type: "turn/start"; chatId?: string; text: string }
  | { type: "turn/interrupt"; chatId: string }
  | { type: "approval/respond"; requestId: number | string; approved: boolean };

export async function startNorvyn(workspace: string): Promise<NorvynServer> {
  let catalog = await loadModelCatalog();
  const preflight = await checkPreflight();
  if (!preflight.ok) return startWithAdapters(workspace, undefined, undefined, undefined, catalog, preflight.message);
  const adapter = await CodexAdapter.connect();
  catalog = await loadModelCatalog(await adapter.listModels());
  return startWithAdapters(workspace, adapter, adapter, adapter, catalog);
}

async function startWithAdapters(
  workspace: string,
  transport: Transport | undefined,
  threadStore: ThreadStore | undefined,
  threadOrganizer: ThreadOrganizer | undefined,
  catalog: Awaited<ReturnType<typeof loadModelCatalog>>,
  preflightError?: string,
): Promise<NorvynServer> {
  const token = randomBytes(32).toString("hex");
  const browserSessions = new Set<string>();
  const chats = new Map<string, ChatState>();
  const approvals = new Map<number | string, { timeout: NodeJS.Timeout }>();
  const approvalTimeoutMs = Number(process.env.NORVYN_APPROVAL_TIMEOUT_MS ?? 30_000);
  const pendingNotifications: ServerNotificationEnvelope[] = [];
  let startingTurns = 0;
  let nextChat = 1;
  const initialChat = newChat(workspace);
  const staticDirectory = findStaticDirectory();
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && requestUrl.pathname === "/session") {
      const payload = await readJsonBody(request).catch(() => undefined) as { access?: unknown } | undefined;
      if (!payload || typeof payload.access !== "string" || !matchesToken(payload.access, token)) {
        response.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify({ message: "Browser access was rejected." }));
        return;
      }
      const browserSession = randomBytes(32).toString("hex");
      browserSessions.add(browserSession);
      response.writeHead(204, {
        "cache-control": "no-store",
        "set-cookie": `norvyn_session=${browserSession}; HttpOnly; SameSite=Strict; Path=/`,
      }).end();
      return;
    }
    if (request.method !== "GET") { response.writeHead(404).end(); return; }
    try {
      const relativePath = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
      const filePath = resolve(staticDirectory, relativePath);
      if (!filePath.startsWith(`${staticDirectory}${sep}`)) throw new Error("Invalid static path");
      const file = await readFile(filePath);
      response.writeHead(200, { "content-type": contentType(filePath), "cache-control": "no-store" });
      response.end(file);
    } catch { response.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("Norvyn client is unavailable."); }
  });

  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const browserSession = cookieValue(request.headers.cookie, "norvyn_session");
    if (requestUrl.pathname !== "/socket" || !browserSession || !browserSessions.has(browserSession)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (connection) => sockets.emit("connection", connection, request));
  });

  sockets.on("connection", (connection) => {
    if (transport && threadStore) {
      send(connection, { type: "connection", status: "connected", workspace, models: catalog.models, chat: initialChat });
      void sendHistory(connection);
    } else {
      send(connection, { type: "connection", status: "disconnected", workspace });
      if (preflightError) send(connection, { type: "preflight/failed", message: preflightError });
    }
    connection.on("message", (payload) => void handleMessage(connection, JSON.parse(payload.toString()) as BrowserMessage).catch((error) => {
      send(connection, { type: "error", message: browserErrorMessage(error) });
    }));
  });

  async function handleMessage(connection: WebSocket, message: BrowserMessage): Promise<void> {
    if (!transport || !threadStore || !threadOrganizer) throw new Error(preflightError ?? "The Provider is unavailable.");
    if (message.type === "history/list") { await sendHistory(connection, message.search); return; }
    if (message.type === "history/workspace/archive" || message.type === "history/workspace/delete") {
      const threads = (await threadStore.listThreads()).filter((thread) => String(thread.cwd) === message.workspace);
      if (!threads.length) throw new Error("No active Chats were found for this Workspace History.");
      for (const thread of threads) {
        if (message.type === "history/workspace/archive") await threadOrganizer.archiveThread(thread.id);
        else await threadOrganizer.deleteThread(thread.id);
      }
      const action = message.type === "history/workspace/archive" ? "archived" : "deleted";
      send(connection, { type: "history/workspace/removed", workspace: message.workspace, threadIds: threads.map((thread) => thread.id), count: threads.length, action });
      await sendHistory(connection);
      return;
    }
    if (message.type === "chat/new") {
      const chat = newChat(message.workspace);
      broadcast({ type: "chat/selected", chat, transcript: [] });
      return;
    }
    if (message.type === "chat/open") {
      const resumed = await threadStore.resumeThread(message.threadId);
      const resumedModel = resumed.model || catalog.defaultModel;
      const chat: ChatState = { id: resumed.thread.id, threadId: resumed.thread.id, workspace: String(resumed.thread.cwd), model: catalog.models.includes(resumedModel) ? resumedModel : catalog.defaultModel, accessMode: "manual" };
      chats.set(chat.id, chat);
      broadcast({ type: "chat/selected", chat, transcript: resumed.thread.turns });
      return;
    }
    if (message.type === "chat/workspace") {
      const chat = requiredChat(message.chatId);
      if (chat.threadId) throw new Error("A Chat's Workspace cannot change after its Thread has started.");
      const workspaceStat = await stat(message.workspace).catch(() => undefined);
      if (!workspaceStat?.isDirectory()) throw new Error(`Workspace does not exist or is not a directory: ${message.workspace}`);
      chat.workspace = resolve(message.workspace);
      broadcast({ type: "chat/updated", chat });
      return;
    }
    if (message.type === "chat/workspace/browse") {
      const chat = requiredChat(message.chatId);
      if (chat.threadId) throw new Error("A Chat's Workspace cannot change after its Thread has started.");
      const selectedWorkspace = await browseWorkspace();
      if (!selectedWorkspace) { send(connection, { type: "workspace/browse/cancelled" }); return; }
      const workspaceStat = await stat(selectedWorkspace).catch(() => undefined);
      if (!workspaceStat?.isDirectory()) throw new Error(`Workspace does not exist or is not a directory: ${selectedWorkspace}`);
      chat.workspace = resolve(selectedWorkspace);
      broadcast({ type: "chat/updated", chat });
      return;
    }
    if (message.type === "chat/model") {
      if (!catalog.models.includes(message.model)) throw new Error(`Unknown model: ${message.model}`);
      const chat = requiredChat(message.chatId);
      chat.model = message.model;
      broadcast({ type: "chat/updated", chat });
      return;
    }
    if (message.type === "chat/access-mode") {
      if (!["manual", "auto-edit", "auto"].includes(message.accessMode)) throw new Error("Unknown Access Mode.");
      const chat = requiredChat(message.chatId);
      chat.accessMode = message.accessMode;
      broadcast({ type: "chat/updated", chat });
      return;
    }
    if (message.type === "turn/start") {
      const chat = requiredChat(message.chatId ?? initialChat.id);
      if (!message.text.trim()) return;
      if (!chat.workspace) throw new Error("Connect Folder before starting a Turn.");
      if (!chat.threadId) chat.threadId = await transport.startThread(chat.workspace, chat.model);
      startingTurns += 1;
      try {
        chat.turnId = await transport.startTurn(chat.threadId, message.text, chat.model);
        broadcast({ type: "turn/started", chatId: chat.id, threadId: chat.threadId, turnId: chat.turnId, text: message.text });
      } finally {
        startingTurns -= 1;
        if (startingTurns === 0) for (const notification of pendingNotifications.splice(0)) translateNotification(notification);
      }
      return;
    }
    if (message.type === "turn/interrupt") {
      const chat = requiredChat(message.chatId);
      if (chat.threadId && chat.turnId) await transport.interruptTurn(chat.threadId, chat.turnId);
      chat.turnId = undefined;
      broadcast({ type: "turn/interrupted", chatId: chat.id });
      return;
    }
    if (message.type === "approval/respond") {
      const approval = approvals.get(message.requestId);
      if (!approval) throw new Error("That approval request is no longer pending.");
      clearTimeout(approval.timeout);
      approvals.delete(message.requestId);
      transport.answerRequest(message.requestId, { decision: message.approved ? "accept" : "decline" });
    }
  }

  transport?.on("request", (request) => handleProviderRequest(request));
  transport?.on("notification", (message) => translateNotification(message));
  transport?.on("processExit", () => {
    for (const chat of chats.values()) if (chat.turnId) {
      broadcast({ type: "turn/failed", chatId: chat.id, message: "The Provider process stopped. This Turn failed; Norvyn is restarting the Provider." });
      chat.turnId = undefined;
    }
  });
  transport?.on("unavailable", (error) => broadcast({ type: "provider/unavailable", message: browserErrorMessage(error) }));

  function handleProviderRequest(request: ServerRequest): void {
    if (!transport) return;
    if (request.method !== "item/fileChange/requestApproval" && request.method !== "item/commandExecution/requestApproval") {
      transport.answerRequest(request.id, { decision: "decline" });
      return;
    }
    const chat = [...chats.values()].find((candidate) => candidate.threadId === request.params.threadId);
    const isFileChange = request.method === "item/fileChange/requestApproval";
    const kind = isFileChange ? "file-change" : "command-execution";
    const shouldApprove = chat?.accessMode === "auto" || (chat?.accessMode === "auto-edit" && kind === "file-change");
    if (shouldApprove) { transport.answerRequest(request.id, { decision: "accept" }); return; }
    const target = isFileChange
      ? request.params.grantRoot ?? request.params.reason ?? request.params.itemId
      : request.params.command ?? request.params.reason ?? request.params.itemId;
    const timeout = setTimeout(() => {
      approvals.delete(request.id);
      transport.answerRequest(request.id, { decision: "decline" });
      broadcast({ type: "approval/expired", requestId: request.id });
    }, approvalTimeoutMs);
    approvals.set(request.id, { timeout });
    broadcast({ type: "approval/request", requestId: request.id, chatId: chat?.id, kind, target });
  }

  function translateNotification(message: ServerNotificationEnvelope): void {
    if (startingTurns > 0) { pendingNotifications.push(message); return; }
    const params = message.params as Record<string, unknown> | undefined;
    if (message.method === "item/agentMessage/delta") broadcast({ type: "agent/message/delta", ...params });
    else if (message.method === "item/reasoning/summaryTextDelta" || message.method === "item/reasoning/textDelta") broadcast({ type: "reasoning/delta", ...params });
    else if (message.method === "item/started" || message.method === "item/completed") {
      const item = params?.item as ThreadItem | undefined;
      if (item && isToolItem(item)) broadcast({ type: "tool/activity", status: message.method === "item/started" ? "in-progress" : "completed", ...params });
    } else if (message.method === "item/commandExecution/outputDelta" || message.method === "item/fileChange/outputDelta") broadcast({ type: "tool/output/delta", ...params });
    else if (message.method === "turn/completed") {
      const threadId = String(params?.threadId ?? "");
      const chat = [...chats.values()].find((candidate) => candidate.threadId === threadId);
      if (chat) chat.turnId = undefined;
      broadcast({ type: "turn/completed", chatId: chat?.id, ...params });
    } else if (message.method === "error") {
      const error = (params?.error ?? {}) as TurnError;
      const threadId = String(params?.threadId ?? "");
      const chat = [...chats.values()].find((candidate) => candidate.threadId === threadId);
      const terminal = params?.willRetry !== true;
      if (chat && terminal) chat.turnId = undefined;
      broadcast({ type: "turn/error", message: explainError(error), chatId: chat?.id, threadId, turnId: params?.turnId, terminal });
    }
  }

  async function sendHistory(connection: WebSocket, search?: string): Promise<void> {
    if (!threadStore) return;
    const threads = await threadStore.listThreads(search);
    const workspaces = [...new Set(threads.map((thread) => String(thread.cwd)).filter(Boolean))];
    send(connection, { type: "history", threads: threads.map(summarizeThread), workspaces });
  }

  function newChat(chatWorkspace?: string): ChatState {
    const chat: ChatState = { id: `new-${nextChat++}`, workspace: chatWorkspace, model: catalog.defaultModel, accessMode: "manual" };
    chats.set(chat.id, chat);
    return chat;
  }
  function requiredChat(id: string): ChatState {
    const chat = chats.get(id);
    if (!chat) throw new Error(`Unknown Chat: ${id}`);
    return chat;
  }
  function broadcast(event: unknown): void { for (const connection of sockets.clients) send(connection, event); }

  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Norvyn could not determine its local address.");
  return {
    url: `http://127.0.0.1:${address.port}/#access=${token}`,
    close: async () => {
      for (const approval of approvals.values()) clearTimeout(approval.timeout);
      transport?.close();
      await close(server, sockets);
    },
  };
}

function summarizeThread(thread: Thread) {
  return { id: thread.id, title: thread.name || thread.preview || "Untitled Chat", preview: thread.preview, workspace: String(thread.cwd), updatedAt: thread.recencyAt ?? thread.updatedAt, createdAt: thread.createdAt };
}

function isToolItem(item: ThreadItem): boolean {
  return ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "imageView", "imageGeneration"].includes(item.type);
}

function explainError(error: TurnError): string {
  if (error.codexErrorInfo === "usageLimitExceeded") {
    return `You've reached your ChatGPT plan usage limit.${error.additionalDetails ? ` ${error.additionalDetails}` : ""}`;
  }
  const providerMessage = readableProviderMessage(error.message);
  if (error.codexErrorInfo === "badRequest" && /model.+not supported.+ChatGPT account/i.test(providerMessage)) {
    return "This model isn't available with your ChatGPT account. Choose another available model and retry.";
  }
  return providerMessage;
}

function browserErrorMessage(error: unknown): string {
  return readableProviderMessage(error instanceof Error ? error.message : String(error));
}

function readableProviderMessage(message: string): string {
  let candidate = message.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === "string") { candidate = parsed.trim(); continue; }
      if (!parsed || typeof parsed !== "object") return "The Provider rejected this request. Check your setup and retry.";
      const record = parsed as { error?: unknown; message?: unknown };
      const nestedError = record.error && typeof record.error === "object" ? record.error as { message?: unknown } : undefined;
      const nestedMessage = typeof nestedError?.message === "string" ? nestedError.message : typeof record.message === "string" ? record.message : undefined;
      if (!nestedMessage) return "The Provider rejected this request. Check your setup and retry.";
      candidate = nestedMessage.trim();
    } catch {
      return /^[\[{]/.test(candidate) ? "The Provider rejected this request. Check your setup and retry." : candidate;
    }
  }
  return /^[\[{]/.test(candidate) ? "The Provider rejected this request. Check your setup and retry." : candidate;
}

function send(connection: WebSocket, event: unknown): void {
  if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(event));
}
function findStaticDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const compiledDirectory = join(moduleDirectory, "public");
  return existsSync(compiledDirectory) ? compiledDirectory : resolve(moduleDirectory, "..");
}
function contentType(filePath: string): string {
  return ({ ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml" } as Record<string, string>)[extname(filePath)] ?? "application/octet-stream";
}
function matchesToken(candidate: string | null, token: string): boolean {
  return Boolean(candidate && candidate.length === token.length && timingSafeEqual(Buffer.from(candidate), Buffer.from(token)));
}
export function folderPickerLaunch(platform = process.platform): { command: string; args: string[] } {
  if (platform !== "win32") throw new Error("Browsing for a Workspace is currently available on Windows only.");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Choose a Norvyn Workspace'",
    "try { if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) } } finally { $dialog.Dispose() }",
  ].join("; ");
  return { command: "powershell.exe", args: ["-NoProfile", "-STA", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script] };
}
function browseWorkspace(): Promise<string | undefined> {
  const launch = folderPickerLaunch();
  return new Promise((resolveWorkspace, reject) => {
    execFile(launch.command, launch.args, { encoding: "utf8" }, (error, stdout) => {
      if (error) { reject(new Error("Windows could not open the folder picker.")); return; }
      resolveWorkspace(stdout.trim() || undefined);
    });
  });
}
function cookieValue(header: string | undefined, name: string): string | undefined {
  return header?.split(";").map((part) => part.trim().split("=", 2)).find(([key]) => key === name)?.[1];
}
function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 4_096) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try { resolveBody(JSON.parse(body)); }
      catch (error) { reject(error); }
    });
    request.on("error", reject);
  });
}
function listen(server: Server): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => { server.off("error", reject); resolveListen(); });
  });
}
function close(server: Server, sockets: WebSocketServer): Promise<void> {
  for (const connection of sockets.clients) connection.close();
  sockets.close();
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}
