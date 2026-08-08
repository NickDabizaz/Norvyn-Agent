import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Turn } from "../../schemas/v2/Turn.js";
import { mergeHistoryPages } from "../features/history.js";
import {
  assertNever,
  type AccessMode,
  type BrowserCommand,
  type ChatState,
  type ConnectionStatus,
  type DiagnosticsReport,
  type ProviderProcessStatus,
  type ServerEvent,
  type ThreadCapabilities,
  type ThreadSummary,
  type UserSettings,
} from "../protocol.js";
import { clampPaneWidth, downloadText, storedNumber, storedSession } from "./app-shell.js";
import { moveMenuFocus, useModalFocus } from "./accessibility.js";
import { autosizeComposer, shouldSubmitComposer } from "./composer.js";
import { useBrowserConnection } from "./connection.js";
import {
  appendAssistantDelta,
  appendReasoningDelta,
  appendToolOutput,
  failTurnTranscript,
  isTranscriptEvent,
  lastCompletedTurnId,
  projectTranscript,
  type TranscriptEntry,
  upsertTool,
} from "./conversation.js";
import { discardDraft, loadDraft, saveDraft } from "./drafts.js";
import { MarkdownContent } from "./markdown.js";
import {
  filterThreads,
  formatThreadTime as formatTime,
  groupThreadsByWorkspace,
  modelOption,
  visibleGroupThreads,
  visibleWorkspaces,
  workspaceName,
  type DropdownOption,
} from "./sidebar.js";
import { visibleTranscript } from "./windowing.js";
import "highlight.js/styles/github-dark.css";
import "./styles.css";

type Approval = { requestId: number | string; kind: "file-change" | "command-execution"; target: string };
type WorkspaceDelete = { workspace: string; count: number };
type AuthState = Extract<ServerEvent, { type: "auth/state" }>["status"];
type Panel = "settings" | "diagnostics" | undefined;

const initialCapabilities: ThreadCapabilities = {
  rename: false,
  pin: false,
  archive: false,
  restore: false,
  delete: false,
  branch: false,
};

export function App() {
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [providerStatus, setProviderStatus] = useState<ProviderProcessStatus>("connecting");
  const [socket, setSocket] = useState<WebSocket>();
  const [retryNonce, setRetryNonce] = useState(0);
  const [preflightError, setPreflightError] = useState<{ kind: "missing" | "outdated"; message: string }>();
  const [authState, setAuthState] = useState<AuthState>();
  const [authMessage, setAuthMessage] = useState<string>();
  const [chat, setChat] = useState<ChatState>();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string>();
  const [archivedHistory, setArchivedHistory] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [unverifiedModels, setUnverifiedModels] = useState<string[]>([]);
  const [modelError, setModelError] = useState<string>();
  const [capabilities, setCapabilities] = useState(initialCapabilities);
  const [workspaceBrowseAvailable, setWorkspaceBrowseAvailable] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [pendingDraftRequest, setPendingDraftRequest] = useState<string>();
  const [revision, setRevision] = useState<{ previousTurnId?: string; label: string }>();
  const [search, setSearch] = useState("");
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(() => new Set());
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(() => new Set());
  const [pendingWorkspaceDelete, setPendingWorkspaceDelete] = useState<WorkspaceDelete>();
  const [approval, setApproval] = useState<Approval>();
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const [workspaceBrowsing, setWorkspaceBrowsing] = useState(false);
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [panel, setPanel] = useState<Panel>();
  const [settings, setSettings] = useState<UserSettings>();
  const [settingsWarning, setSettingsWarning] = useState<string>();
  const [settingsError, setSettingsError] = useState<string>();
  const [operationError, setOperationError] = useState<Extract<ServerEvent, { type: "operation/error" }>>();
  const [diagnostics, setDiagnostics] = useState<DiagnosticsReport>();
  const [update, setUpdate] = useState<{
    installed: string;
    available: string;
    progress: string[];
    status?: string;
  }>();
  const [historyWidth, setHistoryWidth] = useState<number | undefined>(() =>
    storedNumber("norvyn.historyWidth"),
  );
  const [layoutWidth, setLayoutWidth] = useState(() =>
    typeof window === "undefined" ? 1024 : window.innerWidth,
  );
  const [historyCollapsed, setHistoryCollapsed] = useState(
    () =>
      storedSession("norvyn.historyCollapsed") === "1" ||
      (typeof window !== "undefined" && window.innerWidth <= 760),
  );
  const layout = useRef<HTMLElement>(null);
  const chatRef = useRef<ChatState | undefined>(undefined);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const workspaceTrigger = useRef<HTMLButtonElement>(null);
  const workspacePicker = useRef<HTMLElement>(null);
  const workspacePickerClose = useRef<HTMLButtonElement>(null);
  const workspacePickerInitial = useRef<HTMLButtonElement>(null);
  const deleteDialog = useRef<HTMLElement>(null);
  const deleteDialogCancel = useRef<HTMLButtonElement>(null);

  useModalFocus(showWorkspacePicker, workspacePicker, workspacePickerInitial, () =>
    setShowWorkspacePicker(false),
  );
  useModalFocus(Boolean(pendingWorkspaceDelete), deleteDialog, deleteDialogCancel, () =>
    setPendingWorkspaceDelete(undefined),
  );

  useBrowserConnection(retryNonce, {
    onEvent: handleServerEvent,
    onSocket: setSocket,
    onStatus: setConnection,
    onBoundaryError: (error) => setOperationError({ type: "operation/error", ...error }),
  });

  useEffect(() => {
    if (!settings) return;
    document.documentElement.dataset.textScale = settings.textScale;
    document.documentElement.dataset.transcriptDensity = settings.transcriptDensity;
  }, [settings]);

  useEffect(() => {
    const update = () => {
      setLayoutWidth(window.innerWidth);
      if (window.innerWidth <= 760) setHistoryCollapsed(true);
    };
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            type: "history/list",
            search: search || undefined,
            archived: archivedHistory,
          } satisfies BrowserCommand),
        );
    }, 180);
    return () => clearTimeout(timer);
  }, [search, archivedHistory, socket]);

  useLayoutEffect(() => {
    autosizeComposer(composerInput.current);
  }, [draft]);

  const visibleThreads = useMemo(() => filterThreads(threads, search), [threads, search]);
  const groupedThreads = useMemo(() => groupThreadsByWorkspace(visibleThreads), [visibleThreads]);
  const renderedTranscript = visibleTranscript(transcript);
  const modelOptions = [
    ...models.map((model) => modelOption(model)),
    ...unverifiedModels.map((model) => modelOption(model, false)),
  ];

  function handleServerEvent(message: ServerEvent) {
    if (
      isTranscriptEvent(message) &&
      "threadId" in message &&
      message.threadId &&
      message.threadId !== chatRef.current?.threadId
    )
      return;
    if (
      (message.type === "turn/interrupted" || message.type === "turn/failed") &&
      message.chatId !== chatRef.current?.id
    )
      return;
    switch (message.type) {
      case "connection":
        setConnection(message.status);
        setProviderStatus(message.providerStatus);
        setModels(message.models ?? []);
        setUnverifiedModels(message.unverifiedModels ?? []);
        setModelError(message.modelError);
        setCapabilities(message.capabilities);
        setWorkspaceBrowseAvailable(message.workspaceBrowseAvailable);
        if (message.chat) selectChat(message.chat);
        return;
      case "operation/error":
        setOperationError(message);
        setWorkspaceBrowsing(false);
        if (message.scope === "workspace-history") setPendingWorkspaceDelete(undefined);
        if (message.scope === "turn")
          setTranscript((current) => failTurnTranscript(current, message.message));
        return;
      case "preflight/failed":
        setPreflightError(message);
        return;
      case "auth/state":
        setAuthState(message.status);
        setAuthMessage(message.message);
        return;
      case "history/page":
        setThreads((current) => mergeHistoryPages(current, message.threads, message.reset));
        setWorkspaces((current) =>
          message.reset ? message.workspaces : [...new Set([...current, ...message.workspaces])],
        );
        setHistoryCursor(message.nextCursor);
        return;
      case "history/changed":
        return;
      case "history/workspace/removed": {
        const removedIds = new Set(message.threadIds);
        setThreads((current) => current.filter((thread) => !removedIds.has(thread.id)));
        setPendingWorkspaceDelete(undefined);
        if (chatRef.current?.threadId && removedIds.has(chatRef.current.threadId))
          transmit({ type: "chat/new" });
        return;
      }
      case "chat/selected":
        selectChat(message.chat, message.transcript);
        setShowWorkspacePicker(false);
        return;
      case "chat/branched":
        selectChat(message.chat, message.transcript);
        return;
      case "chat/updated":
        selectChat(message.chat);
        setShowWorkspacePicker(false);
        setWorkspaceBrowsing(false);
        return;
      case "workspace/browse/cancelled":
        setWorkspaceBrowsing(false);
        return;
      case "turn/accepted":
        if (!message.requestId || message.requestId === pendingDraftRequest) {
          if (chatRef.current) discardDraft(localStorage, chatRef.current.id);
          setDraft("");
          setPendingDraftRequest(undefined);
          setRevision(undefined);
        }
        return;
      case "turn/started": {
        const next = chatRef.current
          ? { ...chatRef.current, threadId: message.threadId, turnId: message.turnId }
          : undefined;
        selectChat(next);
        const previousTurnId = lastCompletedTurnId(transcript);
        setTranscript((current) => [
          ...current,
          {
            kind: "user",
            id: `user-${message.turnId}`,
            turnId: message.turnId,
            previousTurnId,
            text: message.text,
            complete: true,
          },
          {
            kind: "assistant",
            id: `assistant-${message.turnId}`,
            turnId: message.turnId,
            previousTurnId,
            text: "",
            complete: false,
          },
        ]);
        return;
      }
      case "agent/message/delta":
        setTranscript((current) => appendAssistantDelta(current, message.delta));
        return;
      case "reasoning/delta":
        setTranscript((current) => appendReasoningDelta(current, message.itemId, message.delta));
        return;
      case "tool/activity":
        setTranscript((current) => upsertTool(current, message.item, message.status));
        return;
      case "tool/output/delta":
        setTranscript((current) => appendToolOutput(current, message.itemId, message.delta));
        return;
      case "turn/completed":
        finishTurn();
        return;
      case "turn/interrupted":
        finishTurn();
        return;
      case "turn/failed":
        finishTurn(message.message);
        return;
      case "turn/error":
        if (!message.terminal) {
          setTranscript((current) => [
            ...current,
            { kind: "error", id: crypto.randomUUID(), text: message.message },
          ]);
          return;
        }
        finishTurn(message.message, true);
        return;
      case "approval/request":
        setApproval(message);
        return;
      case "approval/expired":
        setApproval(undefined);
        return;
      case "provider/state":
        setProviderStatus(message.status);
        if (message.status === "connected") setPreflightError(undefined);
        return;
      case "settings/state":
        setSettings(message.settings);
        setModels(message.models);
        setUnverifiedModels(message.unverifiedModels);
        setModelError(message.modelError);
        setSettingsWarning(message.warning);
        setProviderStatus(message.providerStatus);
        return;
      case "settings/saved":
        setSettings(message.settings);
        setModels(message.models);
        setUnverifiedModels(message.unverifiedModels);
        setModelError(message.modelError);
        setSettingsError(undefined);
        return;
      case "settings/error":
        setSettingsError(message.message);
        return;
      case "diagnostics/state":
        setDiagnostics(message.report);
        return;
      case "diagnostics/export":
        downloadText(message.filename, message.content);
        return;
      case "update/available":
        setUpdate({ ...message, progress: [] });
        return;
      case "update/prepared":
        if (
          window.confirm(
            `Run this global update?\n\n${message.command}\n\nNorvyn will never run it automatically.`,
          )
        )
          transmit({ type: "update/start", version: message.version, confirmed: true });
        return;
      case "update/progress":
        setUpdate((current) =>
          current
            ? { ...current, progress: [...current.progress.slice(-7), message.line], status: "Updating…" }
            : current,
        );
        return;
      case "update/completed":
        setUpdate((current) =>
          current
            ? { ...current, status: `Updated to ${message.version}. Restart Norvyn to use it.` }
            : current,
        );
        return;
      case "update/failed":
        setUpdate((current) => (current ? { ...current, status: message.message } : current));
        return;
      default:
        return assertNever(message);
    }
  }
  function selectChat(next?: ChatState, turns?: Turn[]) {
    if (next?.id && next.id !== chatRef.current?.id) {
      setDraft(loadDraft(localStorage, next.id));
      setRevision(undefined);
    }
    chatRef.current = next;
    setChat(next);
    if (turns) setTranscript(projectTranscript(turns));
  }

  function finishTurn(message?: string, failed = false) {
    const next = chatRef.current ? { ...chatRef.current, turnId: undefined } : undefined;
    selectChat(next);
    setTranscript((current) => {
      const completed = current.map((entry) =>
        entry.kind === "assistant" ? { ...entry, complete: true } : entry,
      );
      if (!message) return completed;
      return failed
        ? failTurnTranscript(completed, message)
        : [...completed, { kind: "error", id: crypto.randomUUID(), text: message }];
    });
  }

  function transmit(message: BrowserCommand): boolean {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function submitDraft() {
    if (!chat || !draft.trim()) return;
    const requestId = crypto.randomUUID();
    const sent = revision
      ? transmit({
          type: "chat/branch",
          chatId: chat.id,
          turnId: revision.previousTurnId,
          text: draft,
          label: revision.label,
        })
      : transmit({ type: "turn/start", chatId: chat.id, text: draft, requestId });
    if (sent) setPendingDraftRequest(requestId);
  }

  function changeDraft(value: string) {
    setDraft(value);
    if (chat) saveDraft(localStorage, chat.id, value);
  }

  function startRevision(entry: Extract<TranscriptEntry, { kind: "user" }>) {
    if (chat?.turnId) return;
    changeDraft(entry.text);
    setRevision({ previousTurnId: entry.previousTurnId, label: "Revised earlier Turn" });
    composerInput.current?.focus();
  }

  function branchFrom(entry: Extract<TranscriptEntry, { kind: "user" | "assistant" }>, retry = false) {
    if (!chat || chat.turnId) return;
    transmit({
      type: "chat/branch",
      chatId: chat.id,
      turnId: retry ? entry.previousTurnId : entry.turnId,
      text: retry ? entry.text : undefined,
      label: retry ? "Retried Turn" : "Branched Chat",
    });
  }

  function setHistoryMode(archived: boolean) {
    setArchivedHistory(archived);
    setThreads([]);
    setHistoryCursor(undefined);
  }

  function resize(event: React.PointerEvent) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (pointer: PointerEvent) => {
      if (!layout.current) return;
      const box = layout.current.getBoundingClientRect();
      const width = clampPaneWidth(pointer.clientX - box.left, box.width);
      setHistoryWidth(width);
      sessionStorage.setItem("norvyn.historyWidth", String(width));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function resizeWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    const total = layout.current?.getBoundingClientRect().width ?? 1024;
    const current = historyWidth ?? 290;
    const step = event.shiftKey ? 48 : 16;
    const requested =
      event.key === "Home"
        ? 220
        : event.key === "End"
          ? total
          : event.key === "ArrowLeft"
            ? current - step
            : event.key === "ArrowRight"
              ? current + step
              : undefined;
    if (requested === undefined) return;
    event.preventDefault();
    const width = clampPaneWidth(requested, total);
    setHistoryWidth(width);
    sessionStorage.setItem("norvyn.historyWidth", String(width));
  }

  const appControls = (
    <div className="app-controls">
      <button type="button" onClick={() => setPanel("settings")}>
        Settings
      </button>
      <button
        type="button"
        onClick={() => {
          setPanel("diagnostics");
          transmit({ type: "diagnostics/get" });
        }}
      >
        Diagnostics
      </button>
    </div>
  );

  if (authState && authState !== "connected" && !preflightError) {
    return (
      <main className="not-connected">
        {appControls}
        <section>
          <p className="eyebrow">LOCAL SESSION</p>
          <h1>Not Connected</h1>
          <p>
            Connect through Codex's Provider-owned browser flow. Norvyn never receives your password or stores
            Provider credentials.
          </p>
          <div className="provider-actions">
            <button
              type="button"
              disabled={authState === "connecting"}
              onClick={() => transmit({ type: "auth/connect" })}
            >
              {authState === "connecting" ? "Connecting…" : "Connect With Codex"}
            </button>
          </div>
          {authMessage && (
            <p className="inline-error" role="alert">
              {authMessage}
            </p>
          )}
        </section>
        {panel && (
          <UtilityPanel
            panel={panel}
            close={() => setPanel(undefined)}
            settings={settings}
            models={models}
            settingsWarning={settingsWarning}
            settingsError={settingsError}
            diagnostics={diagnostics}
            providerStatus={providerStatus}
            transmit={transmit}
          />
        )}
      </main>
    );
  }

  return (
    <main
      ref={layout}
      className={`app-shell ${historyCollapsed ? "history-collapsed" : ""}`}
      style={{
        gridTemplateColumns: historyCollapsed
          ? "minmax(420px, 1fr)"
          : historyWidth
            ? `${historyWidth}px 7px minmax(420px, 1fr)`
            : "minmax(220px, 20%) 7px minmax(420px, 80%)",
      }}
    >
      {!historyCollapsed && (
        <>
          <aside className="history" aria-label="History">
            <header className="brand">
              <span>NORVYN_</span>
              <div className="brand-controls">
                <i className={`signal signal--${connection}`} title={connection} />
                <button
                  className="sidebar-toggle"
                  type="button"
                  aria-label="Hide History"
                  onClick={() => {
                    setHistoryCollapsed(true);
                    sessionStorage.setItem("norvyn.historyCollapsed", "1");
                  }}
                >
                  ‹
                </button>
              </div>
            </header>
            <button className="new-chat" onClick={() => transmit({ type: "chat/new" })}>
              ＋ New Chat
            </button>
            <div className="history-tabs">
              <button className={!archivedHistory ? "active" : ""} onClick={() => setHistoryMode(false)}>
                Active
              </button>
              <button className={archivedHistory ? "active" : ""} onClick={() => setHistoryMode(true)}>
                Archived
              </button>
            </div>
            <label className="search">
              <span>Search Chats</span>
              <input
                aria-label="Search Chats"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search history…"
              />
            </label>
            <nav className="thread-list" aria-label="Past Chats">
              {groupedThreads.map((group) => (
                <WorkspaceGroup
                  key={group.workspace}
                  group={group}
                  chat={chat}
                  collapsed={collapsedWorkspaces.has(group.workspace)}
                  expanded={expandedWorkspaces.has(group.workspace)}
                  archived={archivedHistory}
                  capabilities={capabilities}
                  onToggle={() =>
                    setCollapsedWorkspaces((current) => toggleSetValue(current, group.workspace))
                  }
                  onExpand={() =>
                    setExpandedWorkspaces((current) => toggleSetValue(current, group.workspace))
                  }
                  onOpen={(threadId) => transmit({ type: "chat/open", threadId })}
                  onThreadCommand={transmit}
                  onDeleteWorkspace={() =>
                    setPendingWorkspaceDelete({ workspace: group.workspace, count: group.threads.length })
                  }
                  onArchiveWorkspace={() =>
                    window.confirm(
                      `Archive every active Chat in ${workspaceName(group.workspace)}? You can restore them later.`,
                    ) && transmit({ type: "history/workspace/archive", workspace: group.workspace })
                  }
                />
              ))}
              {!visibleThreads.length && (
                <p className="empty">No {archivedHistory ? "archived " : ""}Chats found.</p>
              )}
              {historyCursor && (
                <button
                  className="load-more"
                  type="button"
                  onClick={() =>
                    transmit({
                      type: "history/list",
                      cursor: historyCursor,
                      search: search || undefined,
                      archived: archivedHistory,
                    })
                  }
                >
                  Load more
                </button>
              )}
            </nav>
          </aside>
          <div
            className="divider"
            role="separator"
            tabIndex={0}
            aria-label="Resize History"
            aria-orientation="vertical"
            aria-valuemin={220}
            aria-valuemax={Math.max(220, layoutWidth - 420)}
            aria-valuenow={Math.round(historyWidth ?? 290)}
            aria-describedby="history-divider-help"
            onPointerDown={resize}
            onKeyDown={resizeWithKeyboard}
          >
            <span />
          </div>
          <span id="history-divider-help" className="sr-only">
            Use Left and Right Arrow keys to resize. Home sets the minimum and End sets the maximum.
          </span>
        </>
      )}
      <section className="chat-panel" aria-label="Chat">
        <header className="chat-toolbar">
          <div className="toolbar-leading">
            {historyCollapsed && (
              <button
                className="sidebar-toggle"
                type="button"
                aria-label="Show History"
                onClick={() => {
                  setHistoryCollapsed(false);
                  sessionStorage.setItem("norvyn.historyCollapsed", "0");
                }}
              >
                ☰
              </button>
            )}
            {chat?.workspace ? (
              <button
                ref={workspaceTrigger}
                className="workspace-path"
                onClick={() => setShowWorkspacePicker(true)}
              >
                {chat.workspace}
              </button>
            ) : (
              <button ref={workspaceTrigger} onClick={() => setShowWorkspacePicker(true)}>
                Connect Folder
              </button>
            )}
          </div>
          <div className="selectors">
            <div className="selector">
              <span>Model</span>
              <Dropdown
                label="Model"
                value={chat?.model ?? ""}
                options={modelOptions}
                onChange={(model) => chat && transmit({ type: "chat/model", chatId: chat.id, model })}
              />
            </div>
            <div className="selector">
              <span>Access Mode</span>
              <Dropdown
                label="Access Mode"
                value={chat?.accessMode ?? "manual"}
                options={accessModeOptions}
                onChange={(accessMode) =>
                  chat &&
                  transmit({
                    type: "chat/access-mode",
                    chatId: chat.id,
                    accessMode: accessMode as AccessMode,
                  })
                }
              />
            </div>
            {appControls}
          </div>
        </header>

        {(modelError || chat?.modelNotice) && (
          <aside className="model-alert" role="status">
            <span>{chat?.modelNotice ?? modelError}</span>
            <button type="button" onClick={() => transmit({ type: "provider/reconnect" })}>
              Retry discovery
            </button>
          </aside>
        )}

        {showWorkspacePicker && (
          <section
            ref={workspacePicker}
            className="workspace-picker"
            role="dialog"
            aria-modal="true"
            aria-label="Workspace picker"
            onKeyDown={(event) => {
              if (moveMenuFocus(event.currentTarget, event.target as HTMLElement, event.key))
                event.preventDefault();
            }}
          >
            <header>
              <div>
                <p className="eyebrow">WORKSPACE</p>
                <h2>Connect Folder</h2>
              </div>
              <button
                ref={workspacePickerClose}
                className="quiet"
                type="button"
                aria-label="Close Workspace picker"
                onClick={() => setShowWorkspacePicker(false)}
              >
                ×
              </button>
            </header>
            <p className="workspace-picker-intro">
              Choose a recent Workspace or browse for another folder on this machine.
            </p>
            {visibleWorkspaces(workspaces).length > 0 && (
              <div className="recent-workspaces">
                <span>Recent · up to 5</span>
                {visibleWorkspaces(workspaces).map((candidate, index) => (
                  <button
                    ref={index === 0 ? workspacePickerInitial : undefined}
                    type="button"
                    data-menu-option
                    key={candidate}
                    onClick={() =>
                      chat && transmit({ type: "chat/workspace", chatId: chat.id, workspace: candidate })
                    }
                  >
                    <span className="workspace-folder" aria-hidden="true" />
                    <strong>{workspaceName(candidate)}</strong>
                    <code>{candidate}</code>
                  </button>
                ))}
              </div>
            )}
            <button
              className="browse-workspace"
              type="button"
              disabled={!chat || workspaceBrowsing || !workspaceBrowseAvailable}
              onClick={() => {
                if (!chat) return;
                setWorkspaceBrowsing(true);
                transmit({ type: "chat/workspace/browse", chatId: chat.id });
              }}
            >
              <span aria-hidden="true">⌕</span>
              <span>
                <strong>
                  {!workspaceBrowseAvailable
                    ? "Folder picker unavailable"
                    : workspaceBrowsing
                      ? "Waiting for folder…"
                      : "Browse folders…"}
                </strong>
                <small>
                  {workspaceBrowseAvailable
                    ? "Open the Windows folder picker"
                    : "Enter an absolute Workspace path below"}
                </small>
              </span>
            </button>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (chat && workspaceDraft.trim())
                  transmit({ type: "chat/workspace", chatId: chat.id, workspace: workspaceDraft });
              }}
            >
              <label htmlFor="workspace-path">Or enter an absolute path</label>
              <div>
                <input
                  id="workspace-path"
                  aria-label="Workspace path"
                  value={workspaceDraft}
                  onChange={(event) => setWorkspaceDraft(event.target.value)}
                  placeholder="C:\path\to\workspace"
                />
                <button>Connect</button>
              </div>
            </form>
          </section>
        )}

        <div
          className={`chat-content ${!preflightError && !transcript.length ? "chat-content--welcome" : ""}`}
        >
          {operationError && (
            <aside className="operation-error" role="alert" data-error-scope={operationError.scope}>
              <span>{operationError.message}</span>
              <button
                type="button"
                onClick={() => {
                  if (operationError.recovery === "reconnect-provider")
                    transmit({ type: "provider/reconnect" });
                  else if (operationError.recovery === "open-settings") setPanel("settings");
                  else if (operationError.recovery === "choose-workspace") setShowWorkspacePicker(true);
                  else if (operationError.recovery === "choose-model")
                    document.querySelector<HTMLButtonElement>('[aria-label="Model"]')?.focus();
                  setOperationError(undefined);
                }}
              >
                {operationError.recovery === "reconnect-provider"
                  ? "Reconnect"
                  : operationError.recovery === "open-settings"
                    ? "Open Settings"
                    : operationError.recovery === "choose-workspace"
                      ? "Choose Workspace"
                      : operationError.recovery === "choose-model"
                        ? "Choose Model"
                        : "Dismiss"}
              </button>
            </aside>
          )}
          <div className="transcript" aria-live="polite">
            {preflightError ? (
              <aside className="preflight-alert" aria-live="assertive">
                <p className="eyebrow">SETUP REQUIRED</p>
                <p>{preflightError.message}</p>
              </aside>
            ) : (
              !transcript.length && (
                <div className="welcome">
                  <p className="eyebrow">
                    <span aria-hidden="true">✦</span> NORVYN / LOCAL AGENT
                  </p>
                  <h1>What should we build today?</h1>
                  <p>Bring an idea. Norvyn keeps the work local and grounded in your Workspace.</p>
                </div>
              )
            )}
            {chat?.origin && (
              <aside className="branch-origin">
                {chat.origin.label} from Chat <code>{chat.origin.threadId}</code>
              </aside>
            )}
            {transcript.length > renderedTranscript.length && (
              <p className="window-note">
                Showing the latest {renderedTranscript.length} transcript entries.
              </p>
            )}
            {renderedTranscript.map((entry) => (
              <TranscriptEntryView
                key={entry.id}
                entry={entry}
                busy={Boolean(chat?.turnId)}
                canBranch={capabilities.branch}
                onRetry={() => entry.kind === "user" && branchFrom(entry, true)}
                onRevise={() => entry.kind === "user" && startRevision(entry)}
                onBranch={() => (entry.kind === "user" || entry.kind === "assistant") && branchFrom(entry)}
              />
            ))}
          </div>

          {approval && (
            <section className="approval">
              <strong>
                {approval.kind === "file-change" ? "File change requested" : "Command requested"}
              </strong>
              <code>{approval.target}</code>
              <div>
                <button
                  onClick={() => {
                    transmit({ type: "approval/respond", requestId: approval.requestId, approved: false });
                    setApproval(undefined);
                  }}
                >
                  Decline
                </button>
                <button
                  onClick={() => {
                    transmit({ type: "approval/respond", requestId: approval.requestId, approved: true });
                    setApproval(undefined);
                  }}
                >
                  Approve
                </button>
              </div>
            </section>
          )}
          {update && (
            <aside className="update-banner">
              <div>
                <strong>Norvyn {update.available} is available</strong>
                <span>Installed: {update.installed}</span>
                {update.status && <p>{update.status}</p>}
                {update.progress.length > 0 && <pre>{update.progress.join("\n")}</pre>}
              </div>
              <button
                type="button"
                onClick={() => transmit({ type: "update/prepare", version: update.available })}
              >
                Update
              </button>
              <button
                type="button"
                aria-label="Dismiss update"
                onClick={() => {
                  transmit({ type: "update/dismiss", version: update.available });
                  setUpdate(undefined);
                }}
              >
                ×
              </button>
            </aside>
          )}
          {pendingWorkspaceDelete && (
            <div className="workspace-delete-backdrop" role="presentation">
              <section
                ref={deleteDialog}
                className="workspace-delete-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="delete-workspace-title"
              >
                <p className="eyebrow">PERMANENT ACTION</p>
                <h2 id="delete-workspace-title">Delete Workspace History?</h2>
                <p>
                  This permanently deletes {pendingWorkspaceDelete.count}{" "}
                  {pendingWorkspaceDelete.count === 1 ? "Chat" : "Chats"} for{" "}
                  <strong>{workspaceName(pendingWorkspaceDelete.workspace)}</strong>.
                </p>
                <code>{pendingWorkspaceDelete.workspace}</code>
                <p className="file-safety">The Workspace folder and every file inside it stay untouched.</p>
                <div>
                  <button
                    ref={deleteDialogCancel}
                    type="button"
                    onClick={() => setPendingWorkspaceDelete(undefined)}
                  >
                    Cancel
                  </button>
                  <button
                    className="danger"
                    type="button"
                    onClick={() =>
                      transmit({
                        type: "history/workspace/delete",
                        workspace: pendingWorkspaceDelete.workspace,
                        confirmed: true,
                      })
                    }
                  >
                    Delete History
                  </button>
                </div>
              </section>
            </div>
          )}

          {revision && (
            <div className="revision-banner">
              <span>{revision.label}; the original Chat will be preserved.</span>
              <button type="button" onClick={() => setRevision(undefined)}>
                Cancel
              </button>
            </div>
          )}
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              submitDraft();
            }}
          >
            <textarea
              ref={composerInput}
              rows={1}
              aria-label="Start a Turn"
              value={draft}
              onChange={(event) => changeDraft(event.target.value)}
              onKeyDown={(event) => {
                if (!shouldSubmitComposer(event.key, event.shiftKey, event.nativeEvent.isComposing)) return;
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }}
              placeholder={
                chat?.workspace ? "Ask Norvyn about this Workspace…" : "Connect a folder to begin…"
              }
              disabled={!chat?.workspace || !chat.model || connection !== "connected"}
            />
            {draft && (
              <button
                type="button"
                className="discard"
                aria-label="Discard draft"
                onClick={() => {
                  if (chat) discardDraft(localStorage, chat.id);
                  setDraft("");
                }}
              >
                Discard
              </button>
            )}
            {chat?.turnId ? (
              <button
                type="button"
                className="stop"
                onClick={() => transmit({ type: "turn/interrupt", chatId: chat.id })}
              >
                Stop
              </button>
            ) : (
              <button
                type="submit"
                aria-label="Send Turn"
                title="Send (Enter)"
                disabled={!draft.trim() || !chat?.workspace || !chat.model || connection !== "connected"}
              >
                <span aria-hidden="true">↑</span>
              </button>
            )}
          </form>
        </div>
      </section>
      {connection === "disconnected" && (
        <aside className="connection-banner">
          <span>Disconnected. Drafts are safe; submitted Turns are never replayed.</span>
          <button type="button" onClick={() => setRetryNonce((value) => value + 1)}>
            Retry now
          </button>
        </aside>
      )}
      {panel && (
        <UtilityPanel
          panel={panel}
          close={() => setPanel(undefined)}
          settings={settings}
          models={models}
          settingsWarning={settingsWarning}
          settingsError={settingsError}
          diagnostics={diagnostics}
          providerStatus={providerStatus}
          transmit={transmit}
        />
      )}
    </main>
  );
}

function WorkspaceGroup({
  group,
  chat,
  collapsed,
  expanded,
  archived,
  capabilities,
  onToggle,
  onExpand,
  onOpen,
  onThreadCommand,
  onDeleteWorkspace,
  onArchiveWorkspace,
}: {
  group: { workspace: string; threads: ThreadSummary[] };
  chat?: ChatState;
  collapsed: boolean;
  expanded: boolean;
  archived: boolean;
  capabilities: ThreadCapabilities;
  onToggle(): void;
  onExpand(): void;
  onOpen(threadId: string): void;
  onThreadCommand(command: BrowserCommand): boolean;
  onDeleteWorkspace(): void;
  onArchiveWorkspace(): void;
}) {
  const displayed = visibleGroupThreads(group.threads, expanded);
  return (
    <section className="workspace-group">
      <div className="workspace-group-heading">
        <button
          className="workspace-group-toggle"
          type="button"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <span className="workspace-chevron" aria-hidden="true">
            {collapsed ? "›" : "⌄"}
          </span>
          <span className="workspace-folder" aria-hidden="true" />
          <strong>{workspaceName(group.workspace)}</strong>
          <small>{group.threads.length}</small>
        </button>
        <details className="workspace-actions">
          <summary aria-label={`Workspace actions for ${workspaceName(group.workspace)}`}>•••</summary>
          <div className="workspace-actions-menu">
            {!archived && (
              <button disabled={!capabilities.archive} onClick={onArchiveWorkspace}>
                Archive Chats
              </button>
            )}
            <button className="danger" disabled={!capabilities.delete} onClick={onDeleteWorkspace}>
              Delete History
            </button>
          </div>
        </details>
      </div>
      {!collapsed && (
        <div className="workspace-threads">
          {displayed.map((thread) => (
            <div className={`thread-row ${thread.id === chat?.threadId ? "active" : ""}`} key={thread.id}>
              <button className="thread-item" onClick={() => onOpen(thread.id)}>
                <strong>
                  {thread.pinned ? "◆ " : ""}
                  {thread.title}
                </strong>
                <time>{formatTime(thread.updatedAt)}</time>
                <small>{thread.preview || "No preview"}</small>
              </button>
              <details className="thread-actions">
                <summary aria-label={`Actions for ${thread.title}`}>•••</summary>
                <div>
                  {!archived && (
                    <button
                      disabled={!capabilities.rename}
                      onClick={() => {
                        const name = window.prompt("Rename Chat", thread.title);
                        if (name?.trim())
                          onThreadCommand({ type: "thread/rename", threadId: thread.id, name });
                      }}
                    >
                      Rename
                    </button>
                  )}
                  <button
                    disabled={!capabilities.pin}
                    onClick={() =>
                      onThreadCommand({ type: "thread/pin", threadId: thread.id, pinned: !thread.pinned })
                    }
                  >
                    {thread.pinned ? "Unpin" : "Pin"}
                  </button>
                  {archived ? (
                    <button
                      disabled={!capabilities.restore}
                      onClick={() => onThreadCommand({ type: "thread/restore", threadId: thread.id })}
                    >
                      Restore
                    </button>
                  ) : (
                    <button
                      disabled={!capabilities.archive}
                      onClick={() => onThreadCommand({ type: "thread/archive", threadId: thread.id })}
                    >
                      Archive
                    </button>
                  )}
                  <button
                    className="danger"
                    disabled={!capabilities.delete}
                    onClick={() => {
                      if (window.confirm(`Permanently delete Chat “${thread.title}”?`))
                        onThreadCommand({ type: "thread/delete", threadId: thread.id, confirmed: true });
                    }}
                  >
                    Delete
                  </button>
                </div>
              </details>
            </div>
          ))}
          {group.threads.length > 5 && (
            <button className="show-more" type="button" onClick={onExpand}>
              {expanded ? "Show less" : `Show ${group.threads.length - 5} more`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function TranscriptEntryView({
  entry,
  busy,
  canBranch,
  onRetry,
  onRevise,
  onBranch,
}: {
  entry: TranscriptEntry;
  busy: boolean;
  canBranch: boolean;
  onRetry(): void;
  onRevise(): void;
  onBranch(): void;
}) {
  if (entry.kind === "reasoning")
    return (
      <details className="reasoning">
        <summary>Reasoning</summary>
        <pre>{entry.text}</pre>
      </details>
    );
  if (entry.kind === "tool")
    return (
      <details className={`tool tool--${entry.status}`}>
        <summary>
          <span>{entry.title}</span>
          <code>{entry.target}</code>
          <i>{entry.status}</i>
        </summary>
        <pre>{entry.output || "Waiting for output…"}</pre>
      </details>
    );
  if (entry.kind === "error")
    return (
      <article className="message message--error">
        <span>error</span>
        <p>{entry.text}</p>
      </article>
    );
  return (
    <article className={`message message--${entry.kind}`}>
      <span>{entry.kind}</span>
      <div>
        <MarkdownContent
          text={entry.text || (entry.kind === "assistant" ? "Thinking…" : "")}
          complete={entry.complete}
        />
        <div className="message-actions">
          {entry.kind === "user" && (
            <>
              <button type="button" disabled={busy} onClick={onRetry}>
                Retry
              </button>
              <button type="button" disabled={busy} onClick={onRevise}>
                Revise
              </button>
            </>
          )}
          <button
            type="button"
            disabled={busy || !canBranch}
            title={!canBranch ? "This Provider does not support branching" : undefined}
            onClick={onBranch}
          >
            Branch
          </button>
        </div>
      </div>
    </article>
  );
}

function UtilityPanel({
  panel,
  close,
  settings,
  models,
  settingsWarning,
  settingsError,
  diagnostics,
  providerStatus,
  transmit,
}: {
  panel: Exclude<Panel, undefined>;
  close(): void;
  settings?: UserSettings;
  models: string[];
  settingsWarning?: string;
  settingsError?: string;
  diagnostics?: DiagnosticsReport;
  providerStatus: ProviderProcessStatus;
  transmit(command: BrowserCommand): boolean;
}) {
  const [form, setForm] = useState(settings);
  const panelRef = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useModalFocus(true, panelRef, closeButton, close);
  return (
    <div className="utility-backdrop">
      <section ref={panelRef} className="utility-panel" role="dialog" aria-modal="true" aria-label={panel}>
        <header>
          <div>
            <p className="eyebrow">NORVYN</p>
            <h2>{panel === "settings" ? "User Settings" : "Diagnostics"}</h2>
          </div>
          <button ref={closeButton} type="button" aria-label="Close" onClick={close}>
            ×
          </button>
        </header>
        {panel === "settings" && form ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              transmit({ type: "settings/save", settings: form });
            }}
          >
            <StatusControls providerStatus={providerStatus} transmit={transmit} />
            <label>
              Default model
              <select
                value={form.defaultModel ?? models[0] ?? ""}
                disabled={!models.length}
                onChange={(event) => setForm({ ...form, defaultModel: event.target.value })}
              >
                {models.map((model) => (
                  <option key={model}>{model}</option>
                ))}
              </select>
            </label>
            <label>
              Custom model catalog
              <textarea
                value={form.customModels.join("\n")}
                placeholder="One unverified custom model per line"
                onChange={(event) =>
                  setForm({
                    ...form,
                    customModels: event.target.value
                      .split(/\r?\n/)
                      .map((value) => value.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <label>
              Codex CLI location
              <input
                value={form.codexPath ?? ""}
                placeholder="codex"
                onChange={(event) => setForm({ ...form, codexPath: event.target.value || undefined })}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.versionChecks}
                onChange={(event) => setForm({ ...form, versionChecks: event.target.checked })}
              />{" "}
              Check for new Norvyn versions
            </label>
            <label>
              Text scale
              <select
                value={form.textScale}
                onChange={(event) =>
                  setForm({ ...form, textScale: event.target.value as UserSettings["textScale"] })
                }
              >
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="large">Large</option>
              </select>
            </label>
            <label>
              Transcript density
              <select
                value={form.transcriptDensity}
                onChange={(event) =>
                  setForm({
                    ...form,
                    transcriptDensity: event.target.value as UserSettings["transcriptDensity"],
                  })
                }
              >
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </select>
            </label>
            {settingsWarning && <p className="inline-warning">{settingsWarning}</p>}
            {settingsError && <p className="inline-error">{settingsError}</p>}
            <button className="primary" type="submit">
              Save valid Settings
            </button>
          </form>
        ) : (
          <div className="diagnostic-content">
            <StatusControls providerStatus={providerStatus} transmit={transmit} />
            {diagnostics ? (
              <dl>
                <dt>Norvyn</dt>
                <dd>{diagnostics.norvynVersion}</dd>
                <dt>Codex CLI</dt>
                <dd>
                  {diagnostics.codexPath} · {diagnostics.codexVersion ?? "unavailable"}
                </dd>
                <dt>Local Session</dt>
                <dd>{diagnostics.localSession}</dd>
                <dt>Provider process</dt>
                <dd>{diagnostics.providerProcess}</dd>
                <dt>Connection</dt>
                <dd>{diagnostics.connection}</dd>
                {diagnostics.nextAction && (
                  <>
                    <dt>Next action</dt>
                    <dd>{diagnostics.nextAction}</dd>
                  </>
                )}
              </dl>
            ) : (
              <p>Loading diagnostics…</p>
            )}
            <div className="panel-actions">
              <button type="button" onClick={() => transmit({ type: "provider/restart" })}>
                Restart Provider
              </button>
              <button type="button" onClick={() => transmit({ type: "diagnostics/export" })}>
                Export sanitized report
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function StatusControls({
  providerStatus,
  transmit,
}: {
  providerStatus: ProviderProcessStatus;
  transmit(command: BrowserCommand): boolean;
}) {
  return (
    <section className="provider-status">
      <span
        className={`signal signal--${providerStatus === "connected" ? "connected" : providerStatus === "connecting" ? "connecting" : "disconnected"}`}
      />
      <div>
        <strong>Provider / Local Session</strong>
        <small>{providerStatus}</small>
      </div>
      <button
        type="button"
        disabled={
          providerStatus === "disconnected" || providerStatus === "missing" || providerStatus === "signed-out"
        }
        onClick={() => transmit({ type: "provider/disconnect" })}
      >
        Disconnect
      </button>
      <button type="button" onClick={() => transmit({ type: "provider/reconnect" })}>
        Reconnect
      </button>
    </section>
  );
}

const accessModeOptions: DropdownOption[] = [
  { value: "manual", label: "Manual", detail: "Ask before actions", tone: "manual" },
  { value: "auto-edit", label: "Auto Edit", detail: "Edit files automatically", tone: "edit" },
  { value: "auto", label: "Auto", detail: "No approval prompts", tone: "auto" },
];

function Dropdown({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: DropdownOption[];
  onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() =>
      menu.current?.querySelector<HTMLElement>('[aria-selected="true"], [role="option"]')?.focus(),
    );
  }, [open]);

  function closeMenu(): void {
    setOpen(false);
    queueMicrotask(() => trigger.current?.focus());
  }

  return (
    <div className={`dropdown ${open ? "open" : ""}`}>
      <button
        ref={trigger}
        className="dropdown-trigger"
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={!selected}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home") {
            event.preventDefault();
            setOpen(true);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            closeMenu();
          }
        }}
      >
        <span className={`model-mark model-mark--${selected?.tone ?? "default"}`} aria-hidden="true" />
        <strong>{selected?.label ?? "Unavailable"}</strong>
        <i aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menu}
          className="dropdown-menu"
          role="listbox"
          aria-label={`${label} options`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeMenu();
            } else if (moveMenuFocus(event.currentTarget, event.target as HTMLElement, event.key))
              event.preventDefault();
          }}
        >
          {options.map((option) => (
            <button
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={option.value === value}
              key={option.value}
              onClick={() => {
                onChange(option.value);
                closeMenu();
              }}
            >
              <span className={`model-mark model-mark--${option.tone ?? "default"}`} aria-hidden="true" />
              <span>
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </span>
              <b aria-hidden="true">{option.value === value ? "✓" : ""}</b>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function toggleSetValue(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
if (typeof document !== "undefined" && document.getElementById("root"))
  createRoot(document.getElementById("root")!).render(<App />);
