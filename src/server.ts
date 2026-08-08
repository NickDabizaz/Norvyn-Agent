import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type { ServerNotificationEnvelope } from "../schemas/ServerNotificationEnvelope.js";
import type { ServerRequest } from "../schemas/ServerRequest.js";
import type { ThreadItem } from "../schemas/v2/ThreadItem.js";
import type { Turn } from "../schemas/v2/Turn.js";
import type { TurnError } from "../schemas/v2/TurnError.js";
import { ApprovalFeature } from "./features/approvals.js";
import { ChatRegistry, type ChatRecord } from "./features/chats.js";
import { createDiagnostics, sanitizedDiagnosticExport } from "./features/diagnostics.js";
import { collectAllThreads, HISTORY_PAGE_SIZE, summarizeThread } from "./features/history.js";
import { PlatformWorkspacePicker, type WorkspacePicker } from "./features/workspace-picker.js";
import {
  checkForUpdate,
  NpmInstaller,
  performConfirmedUpdate,
  updateCommand,
  type Installer,
  type RegistryFetcher,
} from "./features/update.js";
import { checkPreflight, loginWithCodex, validateCodexPath, type Preflight } from "./preflight.js";
import { checkClaudePreflight, loginWithClaude, validateClaudePath } from "./claude-preflight.js";
import { ClaudeAdapter } from "./claude-transport.js";
import {
  assertNever,
  parseBrowserCommand,
  type BrowserCommand,
  type ChatState,
  type DiagnosticsReport,
  type OperationScope,
  ProtocolDecodeError,
  type ProviderKind,
  type ProviderProcessStatus,
  type ServerEvent,
  type ThreadCapabilities,
  type UserSettings,
} from "./protocol.js";
import {
  loadUserSettings,
  providerModelCatalog,
  saveUserSettings,
  type SettingsLoadResult,
} from "./settings.js";
import {
  CodexAdapter,
  ProviderBoundaryError,
  type ModelSource,
  type ThreadStore,
  type Transport,
} from "./transport.js";
import { NORVYN_VERSION } from "./version.js";

export interface NorvynServer {
  readonly url: string;
  close(): Promise<void>;
}
type ProviderAdapter = Transport & ThreadStore & ModelSource;

export interface NorvynDependencies {
  connectProvider(settings: UserSettings): Promise<ProviderAdapter>;
  preflight(settings: UserSettings): Promise<Preflight>;
  login(settings: UserSettings): Promise<void>;
  installer: Installer;
  registryFetcher?: RegistryFetcher;
  workspacePicker: WorkspacePicker;
  sessionToken(): string;
  sessionTokenTtlMs: number;
  now(): number;
  port: number;
}

interface Runtime {
  adapter?: ProviderAdapter;
  preflight: Preflight;
  providerStatus: ProviderProcessStatus;
  availableModels: string[];
  modelDiscoveryError?: string;
  settingsResult: SettingsLoadResult;
}

const noCapabilities: ThreadCapabilities = {
  rename: false,
  pin: false,
  archive: false,
  restore: false,
  delete: false,
  branch: false,
};

export async function startNorvyn(
  workspace: string,
  overrides: Partial<NorvynDependencies> = {},
): Promise<NorvynServer> {
  const dependencies: NorvynDependencies = {
    connectProvider: (settings) =>
      settings.provider === "anthropic"
        ? ClaudeAdapter.connect({ claudePath: settings.claudePath })
        : CodexAdapter.connect(settings.codexPath),
    preflight: (settings) =>
      settings.provider === "anthropic"
        ? checkClaudePreflight(settings.claudePath)
        : checkPreflight(settings.codexPath),
    login: (settings) =>
      settings.provider === "anthropic"
        ? loginWithClaude(settings.claudePath)
        : loginWithCodex(settings.codexPath),
    installer: new NpmInstaller(),
    workspacePicker: new PlatformWorkspacePicker(),
    sessionToken: () => randomBytes(32).toString("hex"),
    sessionTokenTtlMs: Number(process.env.NORVYN_SESSION_TTL_MS ?? 120_000),
    now: Date.now,
    port: 0,
    ...overrides,
  };
  const settingsResult = await loadUserSettings();
  const preflight = await dependencies.preflight(settingsResult.settings);
  const runtime: Runtime = {
    preflight,
    providerStatus: preflight.ok
      ? "connecting"
      : preflight.kind === "missing"
        ? "missing"
        : preflight.kind === "signed-out" || preflight.kind === "expired"
          ? "signed-out"
          : "failed",
    availableModels: [],
    settingsResult,
  };
  if (preflight.ok) {
    try {
      runtime.adapter = await dependencies.connectProvider(settingsResult.settings);
      runtime.providerStatus = "connected";
      await discoverModels(runtime, runtime.adapter);
    } catch {
      runtime.providerStatus = "failed";
    }
  }
  return startRuntime(workspace, runtime, dependencies);
}

async function startRuntime(
  workspace: string,
  runtime: Runtime,
  dependencies: NorvynDependencies,
): Promise<NorvynServer> {
  const token = dependencies.sessionToken();
  const tokenExpiresAt = dependencies.now() + dependencies.sessionTokenTtlMs;
  let tokenConsumed = false;
  const browserSessions = new Set<string>();
  const chats = new ChatRegistry();
  const approvalTimeoutMs = Number(process.env.NORVYN_APPROVAL_TIMEOUT_MS ?? 30_000);
  const pendingNotifications: ServerNotificationEnvelope[] = [];
  const dismissedVersions = new Set<string>();
  let startingTurns = 0;
  let connectionStatus: DiagnosticsReport["connection"] = runtime.adapter ? "connected" : "disconnected";
  let catalog = providerModelCatalog(
    runtime.availableModels,
    runtime.settingsResult.settings,
    runtime.modelDiscoveryError,
  );
  const initialChat = newChat(workspace);
  let selectedChatId = initialChat.id;
  let historyRefreshScheduled = false;
  let mutatingHistory = 0;
  const ignoredHistoryNotifications = new Set<string>();
  const approvals = new ApprovalFeature(approvalTimeoutMs, broadcast);
  const staticDirectory = findStaticDirectory();
  const server = createServer(async (request, response) => {
    applySecurityHeaders(response);
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (["access", "token", "api_key", "apikey"].some((name) => requestUrl.searchParams.has(name))) {
      response
        .writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
        .end(
          JSON.stringify({
            scope: "authorization",
            code: "authorization.query-secret-rejected",
            message: "Browser access values are not accepted in query strings.",
          }),
        );
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/session") {
      const expectedOrigin = loopbackOrigin(server);
      if (!expectedOrigin || request.headers.origin !== expectedOrigin) {
        response
          .writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
          .end(
            JSON.stringify({
              scope: "authorization",
              code: "authorization.origin-rejected",
              message: "Browser authorization must originate from this Norvyn instance.",
            }),
          );
        return;
      }
      const payload = (await readJsonBody(request).catch(() => undefined)) as
        { access?: unknown } | undefined;
      if (
        tokenConsumed ||
        dependencies.now() > tokenExpiresAt ||
        !payload ||
        typeof payload.access !== "string" ||
        !matchesToken(payload.access, token)
      ) {
        response
          .writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
          .end(
            JSON.stringify({
              scope: "authorization",
              code: "authorization.denied",
              message: "Browser access was rejected. Reopen Norvyn from its local launch command.",
            }),
          );
        return;
      }
      tokenConsumed = true;
      const browserSession = randomBytes(32).toString("hex");
      browserSessions.add(browserSession);
      response
        .writeHead(204, {
          "cache-control": "no-store",
          "set-cookie": `norvyn_session=${browserSession}; HttpOnly; SameSite=Strict; Path=/`,
        })
        .end();
      return;
    }
    if (requestUrl.pathname === "/session") {
      response.writeHead(405, { allow: "POST", "content-type": "application/json; charset=utf-8" }).end(
        JSON.stringify({
          scope: "authorization",
          code: "authorization.method-not-allowed",
          message: "Browser Sessions are created only with POST.",
        }),
      );
      return;
    }
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
      response
        .writeHead(503, { "content-type": "text/plain; charset=utf-8" })
        .end("Norvyn client is unavailable.");
    }
  });

  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const browserSession = cookieValue(request.headers.cookie, "norvyn_session");
    const address = server.address();
    const expectedOrigin =
      address && typeof address !== "string" ? `http://127.0.0.1:${address.port}` : undefined;
    if (
      requestUrl.pathname !== "/socket" ||
      request.headers.origin !== expectedOrigin ||
      !browserSession ||
      !browserSessions.has(browserSession)
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (connection) =>
      sockets.emit("connection", connection, request),
    );
  });

  sockets.on("connection", (connection) => {
    sendConnection(connection);
    send(connection, settingsEvent());
    send(connection, { type: "diagnostics/state", report: diagnostics() });
    const currentPreflight = runtime.preflight;
    if (currentPreflight.ok && runtime.adapter) void sendHistory(connection, { type: "history/list" });
    else if (currentPreflight.kind === "signed-out" || currentPreflight.kind === "expired")
      send(connection, { type: "auth/state", status: "required" });
    else if (!currentPreflight.ok)
      send(connection, {
        type: "preflight/failed",
        kind: currentPreflight.kind,
        message: currentPreflight.message,
      });

    connection.on("message", (payload) => {
      void receiveBrowserMessage(connection, payload.toString());
    });
  });

  attachAdapter(runtime.adapter);

  async function receiveBrowserMessage(connection: WebSocket, payload: string): Promise<void> {
    let command: BrowserCommand;
    try {
      command = parseBrowserCommand(JSON.parse(payload));
    } catch (error) {
      const decodeError =
        error instanceof SyntaxError
          ? new ProtocolDecodeError("invalid-json", "The browser sent malformed JSON.")
          : error;
      sendOperationError(connection, "protocol", decodeError);
      return;
    }
    try {
      await handleMessage(connection, command);
    } catch (error) {
      sendOperationError(connection, commandScope(command), error);
    }
  }

  function sendOperationError(connection: WebSocket, scope: OperationScope, error: unknown): void {
    const message = browserErrorMessage(error);
    const code =
      error instanceof ProtocolDecodeError ? `protocol.${error.code}` : `${scope}.operation-failed`;
    const recovery =
      scope === "provider"
        ? "reconnect-provider"
        : scope === "workspace"
          ? "choose-workspace"
          : scope === "settings"
            ? "open-settings"
            : scope === "turn" && /model/i.test(message)
              ? "choose-model"
              : "retry";
    send(connection, { type: "operation/error", scope, code, message, recovery });
  }

  async function handleMessage(connection: WebSocket, message: BrowserCommand): Promise<void> {
    switch (message.type) {
      case "settings/get":
        send(connection, settingsEvent());
        return;
      case "settings/save":
        await saveSettings(connection, message.settings);
        return;
      case "diagnostics/get":
        send(connection, { type: "diagnostics/state", report: diagnostics() });
        return;
      case "diagnostics/export": {
        const report = diagnostics();
        send(connection, {
          type: "diagnostics/export",
          filename: `norvyn-diagnostics-${Date.now()}.json`,
          content: sanitizedDiagnosticExport(report),
        });
        return;
      }
      case "auth/connect":
        await connectAuthentication();
        return;
      case "provider/disconnect":
        disconnectProvider("Provider disconnected by the user.");
        return;
      case "provider/reconnect":
        await reconnectProvider();
        return;
      case "provider/restart":
        await restartProvider();
        return;
      case "update/dismiss":
        dismissedVersions.add(message.version);
        return;
      case "update/prepare":
        send(connection, {
          type: "update/prepared",
          version: message.version,
          command: updateCommand(message.version),
        });
        return;
      case "update/start":
        if (message.confirmed !== true) {
          throw new Error("Update installation requires explicit confirmation.");
        }
        await installUpdate(message.version);
        return;
      default:
        break;
    }

    const adapter = requireAdapter();
    switch (message.type) {
      case "history/list":
        await sendHistory(connection, message);
        return;
      case "history/workspace/archive":
      case "history/workspace/delete":
        await removeWorkspaceHistory(message);
        return;
      case "chat/new": {
        const chat = newChat(message.workspace);
        selectedChatId = chat.id;
        broadcast({ type: "chat/selected", chat: publicChat(chat), transcript: [] });
        return;
      }
      case "chat/open":
        await openChat(message.threadId);
        return;
      case "chat/workspace":
        await setWorkspace(message.chatId, message.workspace);
        return;
      case "chat/workspace/browse":
        await browseForWorkspace(connection, message.chatId);
        return;
      case "chat/model":
        setModel(message.chatId, message.model);
        return;
      case "chat/effort":
        setEffort(message.chatId, message.effort);
        return;
      case "chat/access-mode":
        setAccessMode(message.chatId, message.accessMode);
        return;
      case "chat/branch":
        await branchChat(message);
        return;
      case "thread/rename":
        await threadAction(message.threadId, "renamed", () =>
          adapter.renameThread(message.threadId, requiredName(message.name)),
        );
        return;
      case "thread/pin":
        await threadAction(message.threadId, message.pinned ? "pinned" : "unpinned", () =>
          adapter.pinThread(message.threadId, message.pinned),
        );
        return;
      case "thread/archive":
        await threadAction(message.threadId, "archived", () => adapter.archiveThread(message.threadId));
        return;
      case "thread/restore":
        await threadAction(message.threadId, "restored", () => adapter.restoreThread(message.threadId));
        return;
      case "thread/delete":
        if (message.confirmed !== true) throw new Error("Deleting a Chat requires explicit confirmation.");
        await threadAction(message.threadId, "deleted", () => adapter.deleteThread(message.threadId));
        return;
      case "turn/start":
        await startTurn(
          message.chatId ?? initialChat.id,
          message.text,
          message.requestId,
          message.attachments,
        );
        return;
      case "turn/interrupt":
        await interruptTurn(message.chatId);
        return;
      case "approval/respond":
        respondApproval(message.requestId, message.approved);
        return;
      default:
        return assertNever(message);
    }
  }

  async function saveSettings(
    connection: WebSocket,
    requested: typeof runtime.settingsResult.settings,
  ): Promise<void> {
    const current = runtime.settingsResult.settings;
    try {
      if (requested.codexPath && requested.codexPath !== current.codexPath)
        await validateCodexPath(requested.codexPath);
      if (requested.claudePath && requested.claudePath !== current.claudePath)
        await validateClaudePath(requested.claudePath);
      if (
        runtime.adapter &&
        requested.defaultModel &&
        !runtime.availableModels.includes(requested.defaultModel) &&
        !requested.customModels.includes(requested.defaultModel)
      ) {
        throw new Error(
          "The default model must be Provider-verified or listed as an unverified custom model.",
        );
      }
      const settings = await saveUserSettings(requested);
      const providerChanged = settings.provider !== current.provider;
      runtime.settingsResult = { settings, migrated: false };
      catalog = providerModelCatalog(runtime.availableModels, settings, runtime.modelDiscoveryError);
      send(connection, {
        type: "settings/saved",
        settings,
        models: runtime.adapter ? catalog.models : [],
        unverifiedModels: catalog.unverifiedModels,
        modelError: catalog.error,
      });
      broadcast(settingsEvent());
      // Switching Provider replaces the Transport, its History, and its models, so it is a reconnect.
      if (providerChanged) await reconnectProvider();
    } catch (error) {
      send(connection, { type: "settings/error", message: browserErrorMessage(error) });
    }
  }

  async function connectAuthentication(): Promise<void> {
    const provider = providerName(runtime.settingsResult.settings.provider);
    if (runtime.preflight.kind !== "signed-out" && runtime.preflight.kind !== "expired")
      throw new Error(`${provider} authentication is not currently required.`);
    broadcast({
      type: "auth/state",
      status: "connecting",
      message: `${provider} opened its Provider-owned sign-in flow.`,
    });
    try {
      await dependencies.login(runtime.settingsResult.settings);
      await reconnectProvider();
      if (!runtime.adapter) throw new Error(`${provider} sign-in did not create a usable Local Session.`);
      broadcast({ type: "auth/state", status: "connected" });
    } catch (error) {
      const message = browserErrorMessage(error);
      const status = /timed out/i.test(message)
        ? "timed-out"
        : /cancel/i.test(message)
          ? "cancelled"
          : "failed";
      broadcast({
        type: "auth/state",
        status,
        message: `${message} Select Connect With ${provider} to retry.`,
      });
    }
  }

  async function reconnectProvider(): Promise<void> {
    if (runtime.adapter) disconnectProvider("Reconnecting Provider.");
    runtime.providerStatus = "connecting";
    connectionStatus = "connecting";
    broadcast({ type: "provider/state", status: "connecting" });
    runtime.preflight = await dependencies.preflight(runtime.settingsResult.settings);
    if (!runtime.preflight.ok) {
      runtime.providerStatus =
        runtime.preflight.kind === "missing"
          ? "missing"
          : runtime.preflight.kind === "signed-out" || runtime.preflight.kind === "expired"
            ? "signed-out"
            : "failed";
      connectionStatus = "disconnected";
      broadcastConnection();
      if (runtime.preflight.kind === "signed-out" || runtime.preflight.kind === "expired")
        broadcast({ type: "auth/state", status: "required" });
      else
        broadcast({
          type: "preflight/failed",
          kind: runtime.preflight.kind,
          message: runtime.preflight.message,
        });
      return;
    }
    try {
      const adapter = await dependencies.connectProvider(runtime.settingsResult.settings);
      runtime.adapter = adapter;
      runtime.providerStatus = "connected";
      connectionStatus = "connected";
      await discoverModels(runtime, adapter);
      catalog = providerModelCatalog(
        runtime.availableModels,
        runtime.settingsResult.settings,
        runtime.modelDiscoveryError,
      );
      reconcileDraftModels();
      attachAdapter(adapter);
      broadcast({
        type: "provider/state",
        status: "connected",
        message: "Provider reconnected successfully.",
      });
      broadcastConnection();
      broadcast(settingsEvent());
      await broadcastInitialHistory();
    } catch (error) {
      runtime.providerStatus = "failed";
      connectionStatus = "disconnected";
      broadcast({ type: "provider/state", status: "failed", message: browserErrorMessage(error) });
      broadcastConnection();
    }
  }

  function disconnectProvider(message: string): void {
    approvals.invalidate();
    failActiveTurns(message);
    runtime.adapter?.close();
    runtime.adapter = undefined;
    runtime.providerStatus = "disconnected";
    connectionStatus = "disconnected";
    broadcast({ type: "provider/state", status: "disconnected", message });
    broadcastConnection();
  }

  async function restartProvider(): Promise<void> {
    const adapter = requireAdapter();
    approvals.invalidate();
    runtime.providerStatus = "connecting";
    connectionStatus = "connecting";
    failActiveTurns("The Provider is restarting. This Turn failed.");
    broadcast({ type: "provider/state", status: "connecting", message: "Restarting Provider…" });
    try {
      await adapter.restart();
      runtime.providerStatus = "connected";
      connectionStatus = "connected";
      await discoverModels(runtime, adapter);
      catalog = providerModelCatalog(
        runtime.availableModels,
        runtime.settingsResult.settings,
        runtime.modelDiscoveryError,
      );
      reconcileDraftModels();
      broadcast({ type: "provider/state", status: "connected", message: "Provider restarted successfully." });
      broadcastConnection();
    } catch (error) {
      runtime.providerStatus = "failed";
      connectionStatus = "disconnected";
      broadcast({
        type: "provider/state",
        status: "failed",
        message: `Provider restart failed: ${browserErrorMessage(error)}`,
      });
      broadcastConnection();
    }
  }

  async function installUpdate(version: string): Promise<void> {
    updateCommand(version);
    try {
      await performConfirmedUpdate(version, true, dependencies.installer, (line) =>
        broadcast({ type: "update/progress", line: sanitizeProgress(line) }),
      );
      broadcast({ type: "update/completed", version, restartRequired: true });
    } catch (error) {
      broadcast({
        type: "update/failed",
        version,
        message: `Update failed; the current installation is still usable. ${browserErrorMessage(error)}`,
      });
    }
  }

  async function sendHistory(
    connection: WebSocket,
    message: Extract<BrowserCommand, { type: "history/list" }>,
  ): Promise<void> {
    const adapter = requireAdapter();
    const page = await adapter.listThreads({
      cursor: message.cursor,
      limit: HISTORY_PAGE_SIZE,
      search: message.search,
      archived: message.archived,
    });
    const summaries = page.threads.map((thread) => summarizeThread(thread, message.archived ?? false));
    const workspaces = [...new Set(summaries.map((thread) => thread.workspace).filter(Boolean))];
    send(connection, {
      type: "history/page",
      threads: summaries,
      workspaces,
      nextCursor: page.nextCursor,
      archived: message.archived ?? false,
      reset: !message.cursor,
    });
  }

  async function broadcastInitialHistory(): Promise<void> {
    for (const connection of sockets.clients) await sendHistory(connection, { type: "history/list" });
  }

  function scheduleHistoryRefresh(): void {
    if (historyRefreshScheduled) return;
    historyRefreshScheduled = true;
    queueMicrotask(() => {
      historyRefreshScheduled = false;
      void broadcastInitialHistory();
    });
  }

  async function removeWorkspaceHistory(
    message: Extract<BrowserCommand, { type: "history/workspace/archive" | "history/workspace/delete" }>,
  ): Promise<void> {
    const adapter = requireAdapter();
    if (message.type === "history/workspace/delete" && message.confirmed !== true)
      throw new Error("Deleting Workspace History requires explicit confirmation.");
    const threads = (await collectAllThreads(adapter)).filter(
      (thread) => String(thread.cwd) === message.workspace,
    );
    if (!threads.length) throw new Error("No active Chats were found for this Workspace History.");
    mutatingHistory += 1;
    try {
      for (const thread of threads) {
        suppressHistoryNotification(thread.id);
        if (message.type === "history/workspace/archive") await adapter.archiveThread(thread.id);
        else await adapter.deleteThread(thread.id);
      }
    } finally {
      mutatingHistory -= 1;
    }
    const action = message.type === "history/workspace/archive" ? "archived" : "deleted";
    broadcast({
      type: "history/workspace/removed",
      workspace: message.workspace,
      threadIds: threads.map((thread) => thread.id),
      count: threads.length,
      action,
    });
    scheduleHistoryRefresh();
  }

  async function openChat(threadId: string): Promise<void> {
    const resumed = await requireAdapter().resumeThread(threadId);
    const resumedModel = resumed.model || undefined;
    const modelAvailable = Boolean(resumedModel && catalog.models.includes(resumedModel));
    const chat: ChatRecord = {
      id: resumed.thread.id,
      threadId: resumed.thread.id,
      workspace: String(resumed.thread.cwd),
      model: modelAvailable ? resumedModel : undefined,
      effort: normalizeReasoningEffort(resumed.reasoningEffort),
      modelNotice:
        resumedModel && !modelAvailable
          ? `This Chat used ${resumedModel}, which the active Provider no longer advertises. Choose a verified model to continue.`
          : undefined,
      accessMode: "manual",
      turns: resumed.thread.turns,
    };
    chats.set(chat);
    selectedChatId = chat.id;
    broadcast({ type: "chat/selected", chat: publicChat(chat), transcript: chat.turns });
  }

  async function setWorkspace(chatId: string, requestedWorkspace: string): Promise<void> {
    const chat = requiredChat(chatId);
    if (chat.threadId) throw new Error("A Chat's Workspace cannot change after its Thread has started.");
    const workspaceStat = await stat(requestedWorkspace).catch(() => undefined);
    if (!workspaceStat?.isDirectory())
      throw new Error(`Workspace does not exist or is not a directory: ${requestedWorkspace}`);
    chat.workspace = resolve(requestedWorkspace);
    broadcast({ type: "chat/updated", chat: publicChat(chat) });
  }

  async function browseForWorkspace(connection: WebSocket, chatId: string): Promise<void> {
    const chat = requiredChat(chatId);
    if (chat.threadId) throw new Error("A Chat's Workspace cannot change after its Thread has started.");
    const result = await dependencies.workspacePicker.select();
    if (result.status === "cancelled") {
      send(connection, { type: "workspace/browse/cancelled" });
      return;
    }
    if (result.status === "unavailable" || result.status === "failed") throw new Error(result.message);
    await setWorkspace(chatId, result.workspace);
  }

  function setModel(chatId: string, model: string): void {
    if (!catalog.models.includes(model) && !catalog.unverifiedModels.includes(model))
      throw new Error(
        `The model is neither Provider-verified nor configured as an unverified override: ${model}`,
      );
    const chat = requiredChat(chatId);
    chat.model = model;
    chat.modelNotice = catalog.unverifiedModels.includes(model)
      ? `${model} is an unverified custom model. The Provider may reject it.`
      : undefined;
    broadcast({ type: "chat/updated", chat: publicChat(chat) });
  }

  function setAccessMode(chatId: string, accessMode: ChatState["accessMode"]): void {
    if (!["manual", "auto-edit", "auto"].includes(accessMode)) throw new Error("Unknown Access Mode.");
    const chat = requiredChat(chatId);
    chat.accessMode = accessMode;
    broadcast({ type: "chat/updated", chat: publicChat(chat) });
  }

  function setEffort(chatId: string, effort: ChatState["effort"]): void {
    const chat = requiredChat(chatId);
    chat.effort = effort;
    broadcast({ type: "chat/updated", chat: publicChat(chat) });
  }

  async function branchChat(message: Extract<BrowserCommand, { type: "chat/branch" }>): Promise<void> {
    const source = requiredChat(message.chatId);
    if (source.turnId) throw new Error("Stop the active Turn or wait for it to finish before branching.");
    if (!source.threadId || !source.workspace) throw new Error("Only a started Chat can be branched.");
    if (!source.model) throw new Error("Choose a Provider-verified model before branching this Chat.");
    const adapter = requireAdapter();
    if (!adapter.capabilities.branch) throw new Error("This Provider does not support Chat branching.");
    let threadId: string;
    let turns: Turn[] = [];
    if (message.turnId) {
      const forked = await adapter.forkThread(source.threadId, message.turnId);
      threadId = forked.thread.id;
      turns = forked.thread.turns;
    } else {
      threadId = await adapter.startThread(source.workspace, source.model);
    }
    const chat: ChatRecord = {
      id: threadId,
      threadId,
      workspace: source.workspace,
      model: source.model,
      effort: source.effort,
      accessMode: "manual",
      origin: { threadId: source.threadId, turnId: message.turnId, label: message.label },
      turns,
    };
    chats.set(chat);
    selectedChatId = chat.id;
    broadcast({ type: "chat/branched", chat: publicChat(chat), transcript: turns });
    scheduleHistoryRefresh();
    if (message.text?.trim()) await startTurn(chat.id, message.text);
  }

  async function threadAction(
    threadId: string,
    action: Extract<ServerEvent, { type: "history/changed" }>["action"],
    operation: () => Promise<void>,
  ): Promise<void> {
    const capability =
      action === "renamed"
        ? "rename"
        : action === "pinned" || action === "unpinned"
          ? "pin"
          : action === "restored"
            ? "restore"
            : action === "archived"
              ? "archive"
              : "delete";
    if (!requireAdapter().capabilities[capability])
      throw new Error(`This Provider does not support ${capability}.`);
    suppressHistoryNotification(threadId);
    mutatingHistory += 1;
    try {
      await operation();
    } finally {
      mutatingHistory -= 1;
    }
    broadcast({ type: "history/changed", threadId, action });
    scheduleHistoryRefresh();
  }

  async function startTurn(
    chatId: string,
    text: string,
    requestId?: string,
    attachments?: Extract<BrowserCommand, { type: "turn/start" }>["attachments"],
  ): Promise<void> {
    const adapter = requireAdapter();
    const chat = requiredChat(chatId);
    if (!text.trim()) return;
    if (chat.turnId) throw new Error("A Turn is already running in this Chat.");
    if (!chat.workspace) throw new Error("Connect Folder before starting a Turn.");
    if (!chat.model)
      throw new Error(
        "No Provider-verified model is selected. Retry discovery or choose an available model.",
      );
    if (!chat.threadId) {
      chat.threadId = await adapter.startThread(chat.workspace, chat.model);
      scheduleHistoryRefresh();
    }
    startingTurns += 1;
    try {
      try {
        chat.turnId = await adapter.startTurn({
          threadId: chat.threadId,
          text,
          model: chat.model,
          effort: chat.effort,
          accessMode: chat.accessMode,
          attachments,
        });
      } catch (error) {
        if (catalog.unverifiedModels.includes(chat.model) && error instanceof ProviderBoundaryError)
          throw new Error(
            "The Provider rejected this unverified custom model. Choose a Provider-verified model and retry.",
          );
        throw error;
      }
      broadcast({ type: "turn/accepted", chatId: chat.id, requestId });
      broadcast({
        type: "turn/started",
        chatId: chat.id,
        threadId: chat.threadId,
        turnId: chat.turnId,
        text,
      });
    } finally {
      startingTurns -= 1;
      if (startingTurns === 0)
        for (const notification of pendingNotifications.splice(0)) translateNotification(notification);
    }
  }

  async function interruptTurn(chatId: string): Promise<void> {
    const chat = requiredChat(chatId);
    if (chat.threadId && chat.turnId) await requireAdapter().interruptTurn(chat.threadId, chat.turnId);
    chat.turnId = undefined;
    broadcast({ type: "turn/interrupted", chatId: chat.id });
  }

  function respondApproval(requestId: number | string, approved: boolean): void {
    approvals.respond(requestId, approved);
  }

  function attachAdapter(adapter?: ProviderAdapter): void {
    if (!adapter) return;
    adapter.on("request", handleProviderRequest);
    adapter.on("notification", translateNotification);
    adapter.on("processExit", () => {
      approvals.invalidate();
      runtime.providerStatus = "connecting";
      connectionStatus = "connecting";
      failActiveTurns("The Provider process stopped. This Turn failed; Norvyn is restarting the Provider.");
      broadcast({ type: "provider/state", status: "connecting", message: "Provider stopped; reconnecting…" });
    });
    adapter.on("ready", () => {
      if (runtime.adapter !== adapter) return;
      runtime.providerStatus = "connected";
      connectionStatus = "connected";
      broadcast({ type: "provider/state", status: "connected" });
      broadcastConnection();
    });
    adapter.on("unavailable", (error) => {
      runtime.providerStatus = "failed";
      connectionStatus = "disconnected";
      broadcast({ type: "provider/state", status: "failed", message: browserErrorMessage(error) });
      broadcastConnection();
    });
  }

  function handleProviderRequest(request: ServerRequest): void {
    const adapter = runtime.adapter;
    if (!adapter) return;
    const threadId = "threadId" in request.params ? request.params.threadId : undefined;
    approvals.handle(request, adapter, threadId ? chats.findByThread(threadId) : undefined);
  }

  function translateNotification(message: ServerNotificationEnvelope): void {
    if (startingTurns > 0) {
      pendingNotifications.push(message);
      return;
    }
    const params = message.params as Record<string, unknown> | undefined;
    if (message.method === "item/agentMessage/delta")
      broadcast({
        type: "agent/message/delta",
        ...(params as Omit<Extract<ServerEvent, { type: "agent/message/delta" }>, "type">),
      });
    else if (
      message.method === "item/reasoning/summaryTextDelta" ||
      message.method === "item/reasoning/textDelta"
    )
      broadcast({
        type: "reasoning/delta",
        ...(params as Omit<Extract<ServerEvent, { type: "reasoning/delta" }>, "type">),
      });
    else if (message.method === "item/started" || message.method === "item/completed") {
      const item = params?.item as ThreadItem | undefined;
      if (item && isToolItem(item))
        broadcast({
          type: "tool/activity",
          status: message.method === "item/started" ? "in-progress" : "completed",
          ...(params as { threadId: string; turnId: string; item: ThreadItem }),
        });
    } else if (
      message.method === "item/commandExecution/outputDelta" ||
      message.method === "item/fileChange/outputDelta"
    ) {
      broadcast({
        type: "tool/output/delta",
        ...(params as Omit<Extract<ServerEvent, { type: "tool/output/delta" }>, "type">),
      });
    } else if (message.method === "turn/completed") {
      const threadId = String(params?.threadId ?? "");
      const chat = chats.findByThread(threadId);
      if (chat) {
        chat.turnId = undefined;
        const turn = params?.turn as Turn | undefined;
        if (turn) chat.turns.push(turn);
      }
      broadcast({
        type: "turn/completed",
        chatId: chat?.id,
        threadId,
      });
    } else if (message.method === "error") {
      const error = (params?.error ?? {}) as TurnError;
      const threadId = String(params?.threadId ?? "");
      const chat = chats.findByThread(threadId);
      const terminal = params?.willRetry !== true;
      if (chat && terminal) chat.turnId = undefined;
      broadcast({
        type: "turn/error",
        // `explained` is an Adapter's claim that it already produced a user-facing sentence, so it is
        // shown verbatim. Without it the message is raw Provider text and must be translated first.
        message: params?.explained === true ? String(error.message) : explainError(error),
        chatId: chat?.id,
        threadId,
        turnId: params?.turnId,
        terminal,
      });
    } else if (
      ["thread/name/updated", "thread/archived", "thread/unarchived", "thread/deleted"].includes(
        message.method,
      )
    ) {
      const threadId = String(params?.threadId ?? "");
      if (ignoredHistoryNotifications.delete(threadId)) return;
      if (mutatingHistory === 0) scheduleHistoryRefresh();
    }
  }

  function failActiveTurns(message: string): void {
    chats.failActive(message, (chatId, failure) =>
      broadcast({ type: "turn/failed", chatId, message: failure }),
    );
  }

  function suppressHistoryNotification(threadId: string): void {
    ignoredHistoryNotifications.add(threadId);
    setTimeout(() => ignoredHistoryNotifications.delete(threadId), 1_000).unref();
  }

  function sendConnection(connection: WebSocket): void {
    const event: ServerEvent = {
      type: "connection",
      status: connectionStatus,
      workspace,
      models: runtime.adapter ? catalog.models : [],
      unverifiedModels: runtime.adapter ? catalog.unverifiedModels : [],
      modelError: runtime.adapter ? catalog.error : undefined,
      chat: runtime.adapter ? publicChat(chats.get(selectedChatId) ?? initialChat) : undefined,
      providerStatus: runtime.providerStatus,
      capabilities: runtime.adapter?.capabilities ?? noCapabilities,
      workspaceBrowseAvailable: dependencies.workspacePicker.available,
    };
    send(connection, event);
  }

  function broadcastConnection(): void {
    for (const connection of sockets.clients) sendConnection(connection);
  }

  function settingsEvent(): Extract<ServerEvent, { type: "settings/state" }> {
    return {
      type: "settings/state",
      settings: runtime.settingsResult.settings,
      models: runtime.adapter ? catalog.models : [],
      unverifiedModels: catalog.unverifiedModels,
      modelError: runtime.adapter ? catalog.error : undefined,
      warning: runtime.settingsResult.warning,
      providerStatus: runtime.providerStatus,
    };
  }

  function diagnostics(): DiagnosticsReport {
    const localSession =
      runtime.preflight.kind === "expired"
        ? "expired"
        : runtime.preflight.kind === "signed-out"
          ? "missing"
          : runtime.preflight.ok
            ? "available"
            : "unknown";
    return createDiagnostics({
      norvynVersion: NORVYN_VERSION,
      provider: runtime.settingsResult.settings.provider,
      providerPath: runtime.preflight.providerPath,
      providerVersion: runtime.preflight.version,
      localSession,
      providerProcess: runtime.providerStatus,
      connection: connectionStatus,
    });
  }

  function newChat(chatWorkspace?: string): ChatRecord {
    return chats.create(chatWorkspace, catalog.defaultModel);
  }

  function reconcileDraftModels(): void {
    for (const chat of chats.values()) {
      if (chat.threadId) continue;
      const available =
        chat.model && (catalog.models.includes(chat.model) || catalog.unverifiedModels.includes(chat.model));
      if (available) continue;
      chat.model = catalog.defaultModel;
      chat.modelNotice = undefined;
    }
  }

  function publicChat(chat: ChatRecord): ChatState {
    return chats.public(chat);
  }

  function requiredChat(id: string): ChatRecord {
    return chats.require(id);
  }

  function requireAdapter(): ProviderAdapter {
    if (!runtime.adapter) throw new Error("The Provider is unavailable. Open Settings to reconnect.");
    return runtime.adapter;
  }

  function broadcast(event: ServerEvent): void {
    for (const connection of sockets.clients) send(connection, event);
  }

  await listen(server, dependencies.port);
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Norvyn could not determine its local address.");

  if (runtime.settingsResult.settings.versionChecks && process.env.NORVYN_SKIP_UPDATE_CHECK !== "1") {
    void checkForUpdate(NORVYN_VERSION, true, dependencies.registryFetcher).then((update) => {
      if (update && !dismissedVersions.has(update.available))
        broadcast({ type: "update/available", installed: update.installed, available: update.available });
    });
  }

  return {
    url: `http://127.0.0.1:${address.port}/#access=${token}`,
    close: async () => {
      approvals.close();
      runtime.adapter?.close();
      await close(server, sockets);
    },
  };
}

async function discoverModels(runtime: Runtime, adapter: ProviderAdapter): Promise<void> {
  runtime.availableModels = [];
  runtime.modelDiscoveryError = undefined;
  try {
    runtime.availableModels = await adapter.listModels();
    if (!runtime.availableModels.length)
      runtime.modelDiscoveryError =
        "The Provider advertised no supported models. Reconnect the Provider or repair the Codex Local Session.";
  } catch {
    runtime.modelDiscoveryError =
      "Model discovery failed. Reconnect the Provider or repair the Codex Local Session, then retry.";
  }
}

/** The user-facing name of a Provider's own tooling, as it appears in sign-in prompts. */
function providerName(provider: ProviderKind): string {
  return provider === "anthropic" ? "Claude" : "Codex";
}

export function commandScope(command: BrowserCommand): OperationScope {
  switch (command.type) {
    case "turn/start":
    case "turn/interrupt":
    case "approval/respond":
    case "chat/effort":
      return "turn";
    case "chat/workspace":
    case "chat/workspace/browse":
      return "workspace";
    case "history/list":
    case "history/workspace/archive":
    case "history/workspace/delete":
    case "thread/rename":
    case "thread/pin":
    case "thread/archive":
    case "thread/restore":
    case "thread/delete":
      return "workspace-history";
    case "auth/connect":
      return "authorization";
    case "provider/disconnect":
    case "provider/reconnect":
    case "provider/restart":
    case "diagnostics/get":
    case "diagnostics/export":
      return "provider";
    case "settings/get":
    case "settings/save":
      return "settings";
    case "update/dismiss":
    case "update/prepare":
    case "update/start":
      return "update";
    case "chat/new":
    case "chat/open":
    case "chat/model":
    case "chat/access-mode":
    case "chat/branch":
      return "chat";
    default:
      return assertNever(command);
  }
}

function normalizeReasoningEffort(value: string | null | undefined): ChatState["effort"] {
  return value === "minimal" || value === "low" || value === "high" || value === "xhigh" ? value : "medium";
}

function isToolItem(item: ThreadItem): boolean {
  return [
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "dynamicToolCall",
    "webSearch",
    "imageView",
    "imageGeneration",
  ].includes(item.type);
}

function explainError(error: TurnError): string {
  if (error.codexErrorInfo === "usageLimitExceeded")
    return `You've reached your ChatGPT plan usage limit.${safeResetDetail(error.additionalDetails)}`;
  const providerMessage = readableProviderMessage(error.message);
  if (
    error.codexErrorInfo === "badRequest" &&
    /model.+not supported.+ChatGPT account/i.test(providerMessage)
  ) {
    return "This model isn't available with your ChatGPT account. Choose another available model and retry.";
  }
  return "The Provider reported an unexpected Turn failure. Retry the Turn or reconnect the Provider.";
}

function browserErrorMessage(error: unknown): string {
  if (error instanceof ProviderBoundaryError)
    return "The Provider rejected this request. Check your setup and retry.";
  return readableProviderMessage(error instanceof Error ? error.message : String(error));
}

function safeResetDetail(detail: string | null): string {
  if (!detail) return "";
  const match = detail.match(/(?:resets?|try again)\s+(?:at|in)\s+[0-9:]+(?:\s+[A-Z]{2,5})?/i);
  return match ? ` ${match[0]}.` : "";
}

function readableProviderMessage(message: string): string {
  let candidate = message.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === "string") {
        candidate = parsed.trim();
        continue;
      }
      if (!parsed || typeof parsed !== "object")
        return "The Provider rejected this request. Check your setup and retry.";
      const record = parsed as { error?: unknown; message?: unknown };
      const nestedError =
        record.error && typeof record.error === "object"
          ? (record.error as { message?: unknown })
          : undefined;
      const nestedMessage =
        typeof nestedError?.message === "string"
          ? nestedError.message
          : typeof record.message === "string"
            ? record.message
            : undefined;
      if (!nestedMessage) return "The Provider rejected this request. Check your setup and retry.";
      candidate = nestedMessage.trim();
    } catch {
      return looksStructured(candidate)
        ? "The Provider rejected this request. Check your setup and retry."
        : candidate;
    }
  }
  return looksStructured(candidate)
    ? "The Provider rejected this request. Check your setup and retry."
    : candidate;
}

function looksStructured(value: string): boolean {
  return value.startsWith("[") || value.startsWith("{");
}

function requiredName(name: string): string {
  const result = name.trim();
  if (!result || result.length > 120) throw new Error("Chat name must be between 1 and 120 characters.");
  return result;
}

function sanitizeProgress(line: string): string {
  return line.replace(/(token|password|authorization|cookie)=\S+/gi, "$1=[redacted]").slice(0, 1_000);
}

function send(connection: WebSocket, event: ServerEvent): void {
  if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(event));
}

function loopbackOrigin(server: Server): string | undefined {
  const address = server.address();
  return address && typeof address !== "string" ? `http://127.0.0.1:${address.port}` : undefined;
}

function findStaticDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(moduleDirectory, "public"), resolve(moduleDirectory, "..", "dist", "public")];
  return (
    candidates.find((candidate) => existsSync(join(candidate, "index.html"))) ??
    resolve(moduleDirectory, "..")
  );
}

function contentType(filePath: string): string {
  return (
    (
      {
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".svg": "image/svg+xml",
      } as Record<string, string>
    )[extname(filePath)] ?? "application/octet-stream"
  );
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
}

function matchesToken(candidate: string | null, token: string): boolean {
  return Boolean(
    candidate &&
    candidate.length === token.length &&
    timingSafeEqual(Buffer.from(candidate), Buffer.from(token)),
  );
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  return header
    ?.split(";")
    .map((part) => part.trim().split("=", 2))
    .find(([key]) => key === name)?.[1];
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
      try {
        resolveBody(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function listen(server: Server, port = 0): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

function close(server: Server, sockets: WebSocketServer): Promise<void> {
  for (const connection of sockets.clients) connection.close();
  sockets.close();
  return new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
}
