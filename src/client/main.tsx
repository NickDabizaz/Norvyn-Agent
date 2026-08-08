import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Connection = "connecting" | "connected" | "disconnected";
type AccessMode = "manual" | "auto-edit" | "auto";
type Chat = { id: string; threadId?: string; workspace?: string; model: string; accessMode: AccessMode; turnId?: string };
type HistoryThread = { id: string; title: string; preview: string; workspace: string; updatedAt: number; createdAt: number };
type TranscriptEntry =
  | { kind: "user" | "assistant" | "error"; id: string; text: string }
  | { kind: "reasoning"; id: string; text: string }
  | { kind: "tool"; id: string; title: string; target: string; output: string; status: "in-progress" | "completed" };
type Approval = { requestId: number | string; kind: string; target: string };
type DropdownOption = { value: string; label: string; detail?: string; tone?: string };
type WorkspaceDelete = { workspace: string; count: number };

export function App() {
  const [connection, setConnection] = useState<Connection>("connecting");
  const [socket, setSocket] = useState<WebSocket>();
  const [preflightError, setPreflightError] = useState<string>();
  const [chat, setChat] = useState<Chat>();
  const [threads, setThreads] = useState<HistoryThread[]>([]);
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(() => new Set());
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(() => new Set());
  const [workspaceMenu, setWorkspaceMenu] = useState<string>();
  const [pendingWorkspaceDelete, setPendingWorkspaceDelete] = useState<WorkspaceDelete>();
  const [approval, setApproval] = useState<Approval>();
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const [workspaceBrowsing, setWorkspaceBrowsing] = useState(false);
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [historyWidth, setHistoryWidth] = useState<number | undefined>(() => {
    const stored = sessionStorage.getItem("norvyn.historyWidth");
    return stored ? Number(stored) : undefined;
  });
  const [historyCollapsed, setHistoryCollapsed] = useState(() => sessionStorage.getItem("norvyn.historyCollapsed") === "1");
  const layout = useRef<HTMLElement>(null);
  const chatRef = useRef<Chat | undefined>(undefined);
  const composerInput = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let connectionSocket: WebSocket | undefined;
    let disposed = false;
    void (async () => {
      try {
        const access = new URLSearchParams(window.location.hash.slice(1)).get("access");
        if (access) {
          const response = await fetch("/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ access }),
          });
          window.history.replaceState(null, "", window.location.pathname);
          if (!response.ok) throw new Error("Norvyn could not authorize this local browser.");
        }
        if (disposed) return;
        const url = new URL(window.location.origin);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.pathname = "/socket";
        connectionSocket = new WebSocket(url);
        setSocket(connectionSocket);
        connectionSocket.onmessage = (event) => handleServerEvent(JSON.parse(event.data));
        connectionSocket.onclose = () => setConnection("disconnected");
        connectionSocket.onerror = () => setConnection("disconnected");
      } catch (error) {
        setConnection("disconnected");
        setPreflightError(error instanceof Error ? error.message : "Norvyn could not authorize this local browser.");
      }
    })();
    return () => { disposed = true; connectionSocket?.close(); };
  }, []);

  const visibleThreads = useMemo(() => filterThreads(threads, search), [threads, search]);
  const groupedThreads = useMemo(() => groupThreadsByWorkspace(visibleThreads), [visibleThreads]);

  useLayoutEffect(() => {
    autosizeComposer(composerInput.current);
  }, [draft]);

  useEffect(() => {
    if (!workspaceMenu) return;
    const closeOutside = (event: PointerEvent) => { if (!(event.target as Element).closest(".workspace-actions")) setWorkspaceMenu(undefined); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setWorkspaceMenu(undefined); };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => { window.removeEventListener("pointerdown", closeOutside); window.removeEventListener("keydown", closeOnEscape); };
  }, [workspaceMenu]);

  function toggleWorkspace(workspace: string) {
    setCollapsedWorkspaces((current) => toggleSetValue(current, workspace));
  }

  function toggleWorkspaceExpansion(workspace: string) {
    setExpandedWorkspaces((current) => toggleSetValue(current, workspace));
  }

  function setHistoryVisibility(collapsed: boolean) {
    setHistoryCollapsed(collapsed);
    sessionStorage.setItem("norvyn.historyCollapsed", collapsed ? "1" : "0");
  }

  function handleServerEvent(message: any) {
    const transcriptEvent = ["agent/message/delta", "reasoning/delta", "tool/activity", "tool/output/delta", "turn/completed", "turn/error"].includes(message.type);
    if (transcriptEvent && message.threadId && message.threadId !== chatRef.current?.threadId) return;
    if ((message.type === "turn/interrupted" || message.type === "turn/failed") && message.chatId !== chatRef.current?.id) return;
    if (message.type === "connection") {
      setConnection(message.status);
      setModels(message.models ?? []);
      if (message.chat) {
        chatRef.current = message.chat;
        setChat(message.chat);
      }
    } else if (message.type === "preflight/failed") {
      setPreflightError(String(message.message ?? "Norvyn cannot reach Codex."));
    } else if (message.type === "history") {
      setThreads(message.threads);
      setWorkspaces(message.workspaces);
    } else if (message.type === "history/workspace/removed") {
      const removedIds = new Set<string>(message.threadIds ?? []);
      setThreads((current) => current.filter((thread) => !removedIds.has(thread.id)));
      setWorkspaces((current) => current.filter((workspace) => workspace !== message.workspace));
      setWorkspaceMenu(undefined);
      setPendingWorkspaceDelete(undefined);
      if (chatRef.current?.threadId && removedIds.has(chatRef.current.threadId)) transmit({ type: "chat/new" });
    } else if (message.type === "chat/selected") {
      chatRef.current = message.chat;
      setChat(message.chat);
      setTranscript(projectTranscript(message.transcript));
      setShowWorkspacePicker(false);
    } else if (message.type === "chat/updated") {
      chatRef.current = message.chat;
      setChat(message.chat);
      setShowWorkspacePicker(false);
      setWorkspaceBrowsing(false);
    } else if (message.type === "workspace/browse/cancelled") {
      setWorkspaceBrowsing(false);
    } else if (message.type === "turn/started") {
      const next = chatRef.current ? { ...chatRef.current, threadId: message.threadId, turnId: message.turnId } : undefined;
      chatRef.current = next;
      setChat(next);
      setTranscript((current) => [...current, { kind: "user", id: `user-${message.turnId}`, text: message.text }, { kind: "assistant", id: `assistant-${message.turnId}`, text: "" }]);
    } else if (message.type === "agent/message/delta") {
      setTranscript((current) => appendAssistantDelta(current, String(message.delta ?? "")));
    } else if (message.type === "reasoning/delta") {
      setTranscript((current) => appendReasoningDelta(current, String(message.itemId ?? "reasoning"), String(message.delta ?? "")));
    } else if (message.type === "tool/activity") {
      setTranscript((current) => upsertTool(current, message.item, message.status));
    } else if (message.type === "tool/output/delta") {
      setTranscript((current) => appendToolOutput(current, String(message.itemId), String(message.delta ?? "")));
    } else if (["turn/completed", "turn/interrupted", "turn/failed"].includes(message.type)) {
      const next = chatRef.current ? { ...chatRef.current, turnId: undefined } : undefined;
      chatRef.current = next;
      setChat(next);
      if (message.message) setTranscript((current) => [...current, { kind: "error", id: crypto.randomUUID(), text: message.message }]);
    } else if (message.type === "turn/error") {
      if (message.terminal === false) {
        setTranscript((current) => [...current, { kind: "error", id: crypto.randomUUID(), text: String(message.message ?? "The Provider is retrying.") }]);
        return;
      }
      const next = chatRef.current ? { ...chatRef.current, turnId: undefined } : undefined;
      chatRef.current = next;
      setChat(next);
      setTranscript((current) => failTurnTranscript(current, String(message.message ?? "The Turn failed.")));
    } else if (message.type === "error" || message.type === "provider/unavailable") {
      setWorkspaceBrowsing(false);
      setTranscript((current) => [...current, { kind: "error", id: crypto.randomUUID(), text: message.message }]);
    } else if (message.type === "approval/request") {
      setApproval(message);
    } else if (message.type === "approval/expired") {
      setApproval(undefined);
    }
  }

  function transmit(message: unknown) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
  function resize(event: React.PointerEvent) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (pointer: PointerEvent) => {
      if (!layout.current) return;
      const box = layout.current.getBoundingClientRect();
      const width = clampPaneWidth(pointer.clientX - box.left, box.width);
      setHistoryWidth(width);
      sessionStorage.setItem("norvyn.historyWidth", String(width));
    };
    const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  return (
    <main ref={layout} className={`app-shell ${historyCollapsed ? "history-collapsed" : ""}`} style={{ gridTemplateColumns: historyCollapsed ? "minmax(420px, 1fr)" : historyWidth ? `${historyWidth}px 7px minmax(420px, 1fr)` : "minmax(220px, 20%) 7px minmax(420px, 80%)" }}>
      {!historyCollapsed && <>
      <aside className="history" aria-label="History">
        <header className="brand"><span>NORVYN_</span><div className="brand-controls"><i className={`signal signal--${connection}`} title={connection} /><button className="sidebar-toggle sidebar-toggle--close" type="button" aria-label="Hide History" title="Hide History" onClick={() => setHistoryVisibility(true)}><span aria-hidden="true">‹</span></button></div></header>
        <button className="new-chat" onClick={() => transmit({ type: "chat/new" })}>＋ New Chat</button>
        <label className="search"><span>Search Chats</span><input aria-label="Search Chats" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search history…" /></label>
        <nav className="thread-list" aria-label="Past Chats">
          {groupedThreads.map((group) => {
            const collapsed = collapsedWorkspaces.has(group.workspace);
            const expanded = expandedWorkspaces.has(group.workspace);
            const displayedThreads = visibleGroupThreads(group.threads, expanded);
            return <section className="workspace-group" key={group.workspace}>
              <div className={`workspace-group-heading ${workspaceMenu === group.workspace ? "menu-open" : ""}`}>
                <button className="workspace-group-toggle" type="button" aria-expanded={!collapsed} onClick={() => toggleWorkspace(group.workspace)}>
                  <span className="workspace-chevron" aria-hidden="true">{collapsed ? "›" : "⌄"}</span>
                  <span className="workspace-folder" aria-hidden="true" />
                  <strong>{workspaceName(group.workspace)}</strong>
                  <small>{group.threads.length}</small>
                </button>
                <div className="workspace-actions">
                  <button className="workspace-actions-trigger" type="button" aria-label={`Workspace actions for ${workspaceName(group.workspace)}`} aria-haspopup="menu" aria-expanded={workspaceMenu === group.workspace} onClick={() => setWorkspaceMenu((current) => current === group.workspace ? undefined : group.workspace)}>•••</button>
                  {workspaceMenu === group.workspace && <div className="workspace-actions-menu" role="menu" aria-label={`${workspaceName(group.workspace)} actions`}>
                    <button type="button" role="menuitem" onClick={() => { transmit({ type: "history/workspace/archive", workspace: group.workspace }); setWorkspaceMenu(undefined); }}><span aria-hidden="true">↘</span><span><strong>Archive Chats</strong><small>Hide from active History</small></span></button>
                    <button className="danger" type="button" role="menuitem" onClick={() => { setPendingWorkspaceDelete({ workspace: group.workspace, count: group.threads.length }); setWorkspaceMenu(undefined); }}><span aria-hidden="true">×</span><span><strong>Delete History</strong><small>Permanent · files stay safe</small></span></button>
                  </div>}
                </div>
                <aside className="workspace-tooltip" role="tooltip">
                  <strong><span className="workspace-folder" aria-hidden="true" />{workspaceName(group.workspace)}</strong>
                  <span>{group.threads.length} {group.threads.length === 1 ? "Chat" : "Chats"}</span>
                  <code>{group.workspace}</code>
                </aside>
              </div>
              {!collapsed && <div className="workspace-threads">
                {displayedThreads.map((thread) => <button key={thread.id} className={`thread-item ${thread.id === chat?.threadId ? "active" : ""}`} onClick={() => transmit({ type: "chat/open", threadId: thread.id })}>
                  <strong>{thread.title}</strong><time>{formatTime(thread.updatedAt)}</time>
                  <small>{thread.preview || "No preview"}</small>
                </button>)}
                {group.threads.length > 5 && <button className="show-more" type="button" onClick={() => toggleWorkspaceExpansion(group.workspace)}>{expanded ? "Show less" : `Show ${group.threads.length - 5} more`}</button>}
              </div>}
            </section>;
          })}
          {!visibleThreads.length && <p className="empty">No Chats found.</p>}
        </nav>
      </aside>
      <div className="divider" role="separator" aria-label="Resize History" aria-orientation="vertical" onPointerDown={resize}><span /></div>
      </>}
      <section className="chat-panel" aria-label="Chat">
        <header className="chat-toolbar">
          <div className="toolbar-leading">{historyCollapsed && <button className="sidebar-toggle sidebar-toggle--open" type="button" aria-label="Show History" title="Show History" onClick={() => setHistoryVisibility(false)}><span aria-hidden="true">☰</span></button>}{chat?.workspace ? <button className="workspace-path" onClick={() => setShowWorkspacePicker(true)}>{chat.workspace}</button> : <button onClick={() => setShowWorkspacePicker(true)}>Connect Folder</button>}</div>
          <div className="selectors">
            <div className="selector"><span>Model</span><Dropdown label="Model" value={chat?.model ?? ""} options={models.map(modelOption)} onChange={(model) => chat && transmit({ type: "chat/model", chatId: chat.id, model })} /></div>
            <div className="selector"><span>Access Mode</span><Dropdown label="Access Mode" value={chat?.accessMode ?? "manual"} options={accessModeOptions} onChange={(accessMode) => chat && transmit({ type: "chat/access-mode", chatId: chat.id, accessMode })} /></div>
          </div>
        </header>

        {showWorkspacePicker && <section className="workspace-picker" aria-label="Workspace picker">
          <header><div><p className="eyebrow">WORKSPACE</p><h2>Connect Folder</h2></div><button className="quiet" type="button" aria-label="Close Workspace picker" onClick={() => setShowWorkspacePicker(false)}>×</button></header>
          <p className="workspace-picker-intro">Choose a recent Workspace or browse for another folder on this machine.</p>
          {visibleWorkspaces(workspaces).length > 0 && <div className="recent-workspaces"><span>Recent · up to 5</span>{visibleWorkspaces(workspaces).map((candidate) => <button type="button" key={candidate} onClick={() => chat && transmit({ type: "chat/workspace", chatId: chat.id, workspace: candidate })}><span className="workspace-folder" aria-hidden="true" /><strong>{workspaceName(candidate)}</strong><code>{candidate}</code></button>)}</div>}
          <button className="browse-workspace" type="button" disabled={!chat || workspaceBrowsing} onClick={() => { if (!chat) return; setWorkspaceBrowsing(true); transmit({ type: "chat/workspace/browse", chatId: chat.id }); }}><span aria-hidden="true">⌕</span><span><strong>{workspaceBrowsing ? "Waiting for folder…" : "Browse folders…"}</strong><small>Open the Windows folder picker</small></span></button>
          <form onSubmit={(event) => { event.preventDefault(); if (chat && workspaceDraft.trim()) transmit({ type: "chat/workspace", chatId: chat.id, workspace: workspaceDraft }); }}><label htmlFor="workspace-path">Or enter an absolute path</label><div><input id="workspace-path" aria-label="Workspace path" value={workspaceDraft} onChange={(event) => setWorkspaceDraft(event.target.value)} placeholder="C:\\path\\to\\workspace" /><button>Connect</button></div></form>
        </section>}

        <div className={`chat-content ${!preflightError && !transcript.length ? "chat-content--welcome" : ""}`}>
          <div className="transcript" aria-live="polite">
            {preflightError ? <aside className="preflight-alert" aria-live="assertive"><p className="eyebrow">SETUP REQUIRED</p><p>{preflightError}</p></aside> : !transcript.length && <div className="welcome">
              <p className="eyebrow"><span aria-hidden="true">✦</span> NORVYN / LOCAL AGENT</p>
              <h1>What should we build today?</h1>
              <p>Bring an idea. Norvyn keeps the work local and grounded in your Workspace.</p>
            </div>}
            {transcript.map((entry) => entry.kind === "reasoning" ? <details className="reasoning" key={entry.id}><summary>Reasoning</summary><pre>{entry.text}</pre></details> : entry.kind === "tool" ? <details className={`tool tool--${entry.status}`} key={entry.id}><summary><span>{entry.title}</span><code>{entry.target}</code><i>{entry.status}</i></summary><pre>{entry.output || "Waiting for output…"}</pre></details> : <article key={entry.id} className={`message message--${entry.kind}`}><span>{entry.kind}</span><p>{entry.text || (entry.kind === "assistant" ? "Thinking…" : "")}</p></article>)}
          </div>

        {approval && <section className="approval"><strong>{approval.kind === "file-change" ? "File change requested" : "Command requested"}</strong><code>{approval.target}</code><div><button onClick={() => { transmit({ type: "approval/respond", requestId: approval.requestId, approved: false }); setApproval(undefined); }}>Decline</button><button onClick={() => { transmit({ type: "approval/respond", requestId: approval.requestId, approved: true }); setApproval(undefined); }}>Approve</button></div></section>}

        {pendingWorkspaceDelete && <div className="workspace-delete-backdrop" role="presentation"><section className="workspace-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-workspace-title">
          <p className="eyebrow">PERMANENT ACTION</p>
          <h2 id="delete-workspace-title">Delete Workspace History?</h2>
          <p>This permanently deletes {pendingWorkspaceDelete.count} {pendingWorkspaceDelete.count === 1 ? "Chat" : "Chats"} for <strong>{workspaceName(pendingWorkspaceDelete.workspace)}</strong>.</p>
          <code>{pendingWorkspaceDelete.workspace}</code>
          <p className="file-safety">The Workspace folder and every file inside it stay untouched.</p>
          <div><button type="button" onClick={() => setPendingWorkspaceDelete(undefined)}>Cancel</button><button className="danger" type="button" onClick={() => transmit({ type: "history/workspace/delete", workspace: pendingWorkspaceDelete.workspace })}>Delete History</button></div>
        </section></div>}

          <form className="composer" onSubmit={(event) => { event.preventDefault(); if (chat && draft.trim()) { transmit({ type: "turn/start", chatId: chat.id, text: draft }); setDraft(""); } }}>
            <textarea ref={composerInput} rows={1} aria-label="Start a Turn" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
              if (!shouldSubmitComposer(event.key, event.shiftKey, event.nativeEvent.isComposing)) return;
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }} placeholder={chat?.workspace ? "Ask Norvyn about this Workspace…" : "Connect a folder to begin…"} disabled={!chat?.workspace || connection !== "connected"} />
            {chat?.turnId ? <button type="button" className="stop" onClick={() => transmit({ type: "turn/interrupt", chatId: chat.id })}>Stop</button> : <button type="submit" aria-label="Send Turn" title="Send (Enter)" disabled={!draft.trim() || !chat?.workspace || connection !== "connected"}><span aria-hidden="true">↑</span></button>}
          </form>
        </div>
      </section>
    </main>
  );
}

export function filterThreads(threads: HistoryThread[], search: string): HistoryThread[] {
  const query = search.trim().toLocaleLowerCase();
  return query ? threads.filter((thread) => thread.title.toLocaleLowerCase().includes(query) || thread.preview.toLocaleLowerCase().includes(query)) : threads;
}
export function groupThreadsByWorkspace(threads: HistoryThread[]): { workspace: string; threads: HistoryThread[] }[] {
  const groups = new Map<string, HistoryThread[]>();
  for (const thread of threads) {
    const workspace = thread.workspace || "Unknown Workspace";
    const group = groups.get(workspace);
    if (group) group.push(thread);
    else groups.set(workspace, [thread]);
  }
  return [...groups].map(([workspace, grouped]) => ({ workspace, threads: grouped }));
}
export function workspaceName(workspace: string): string {
  return workspace.split(/[\\/]+/).filter(Boolean).at(-1) ?? workspace;
}
export function visibleGroupThreads(threads: HistoryThread[], expanded: boolean): HistoryThread[] {
  return expanded ? threads : threads.slice(0, 5);
}
export function visibleWorkspaces(workspaces: string[]): string[] { return workspaces.slice(0, 5); }
export function modelOption(model: string): DropdownOption {
  if (model === "gpt-5.6" || model === "gpt-5.6-sol") return { value: model, label: "GPT-5.6 Sol", detail: "Frontier", tone: "sol" };
  if (model === "gpt-5.6-terra") return { value: model, label: "GPT-5.6 Terra", detail: "Balanced", tone: "terra" };
  if (model === "gpt-5.6-luna") return { value: model, label: "GPT-5.6 Luna", detail: "Efficient", tone: "luna" };
  return { value: model, label: model, detail: "Codex" };
}
export function clampPaneWidth(requested: number, total: number): number { return Math.min(Math.max(requested, 220), Math.max(220, total - 420)); }

export function autosizeComposer(input: HTMLTextAreaElement | null): void {
  if (!input) return;
  input.style.height = "auto";
  input.style.overflowY = "hidden";
  input.style.height = `${input.scrollHeight}px`;
  if (input.scrollHeight > input.clientHeight) input.style.overflowY = "auto";
}
export function shouldSubmitComposer(key: string, shiftKey: boolean, isComposing: boolean): boolean {
  return key === "Enter" && !shiftKey && !isComposing;
}
export function failTurnTranscript(entries: TranscriptEntry[], message: string, id: string = crypto.randomUUID()): TranscriptEntry[] {
  const last = entries.at(-1);
  const completed = last?.kind === "assistant" && !last.text ? entries.slice(0, -1) : entries;
  return [...completed, { kind: "error", id, text: message }];
}

const accessModeOptions: DropdownOption[] = [
  { value: "manual", label: "Manual", detail: "Ask before actions", tone: "manual" },
  { value: "auto-edit", label: "Auto Edit", detail: "Edit files automatically", tone: "edit" },
  { value: "auto", label: "Auto", detail: "No approval prompts", tone: "auto" },
];

function Dropdown({ label, value, options, onChange }: { label: string; value: string; options: DropdownOption[]; onChange(value: string): void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); root.current?.querySelector<HTMLButtonElement>(".dropdown-trigger")?.focus(); } };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => { window.removeEventListener("pointerdown", closeOutside); window.removeEventListener("keydown", closeOnEscape); };
  }, [open]);

  function moveFocus(event: React.KeyboardEvent, direction: number) {
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(current + direction + items.length) % items.length].focus();
  }

  return <div className={`dropdown ${open ? "open" : ""}`} ref={root}>
    <button className="dropdown-trigger" type="button" aria-label={label} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)} onKeyDown={(event) => {
      if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setOpen(true); queueMicrotask(() => root.current?.querySelector<HTMLButtonElement>("[role=option]")?.focus()); }
    }}>
      <span className={`model-mark model-mark--${selected?.tone ?? "default"}`} aria-hidden="true" />
      <strong>{selected?.label ?? "Select"}</strong>
      <i aria-hidden="true" />
    </button>
    {open && <div className="dropdown-menu" role="listbox" aria-label={`${label} options`}>
      {options.map((option) => <button type="button" role="option" aria-selected={option.value === value} key={option.value} onKeyDown={(event) => {
        if (event.key === "ArrowDown") moveFocus(event, 1);
        if (event.key === "ArrowUp") moveFocus(event, -1);
      }} onClick={() => { onChange(option.value); setOpen(false); }}>
        <span className={`model-mark model-mark--${option.tone ?? "default"}`} aria-hidden="true" />
        <span><strong>{option.label}</strong><small>{option.detail}</small></span>
        <b aria-hidden="true">{option.value === value ? "✓" : ""}</b>
      </button>)}
    </div>}
  </div>;
}

function toggleSetValue(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function appendAssistantDelta(entries: TranscriptEntry[], delta: string): TranscriptEntry[] {
  let index = -1;
  for (let position = entries.length - 1; position >= 0; position -= 1) if (entries[position].kind === "assistant") { index = position; break; }
  if (index < 0) return [...entries, { kind: "assistant", id: crypto.randomUUID(), text: delta }];
  return entries.map((entry, position) => position === index && entry.kind === "assistant" ? { ...entry, text: entry.text + delta } : entry);
}
function appendReasoningDelta(entries: TranscriptEntry[], id: string, delta: string): TranscriptEntry[] {
  const found = entries.findIndex((entry) => entry.kind === "reasoning" && entry.id === id);
  return found < 0 ? [...entries, { kind: "reasoning", id, text: delta }] : entries.map((entry, index) => index === found && entry.kind === "reasoning" ? { ...entry, text: entry.text + delta } : entry);
}
function upsertTool(entries: TranscriptEntry[], item: any, status: "in-progress" | "completed"): TranscriptEntry[] {
  const tool = describeTool(item, status);
  const found = entries.findIndex((entry) => entry.kind === "tool" && entry.id === tool.id);
  return found < 0 ? [...entries, tool] : entries.map((entry, index) => index === found && entry.kind === "tool" ? { ...entry, ...tool, output: tool.output || entry.output } : entry);
}
function appendToolOutput(entries: TranscriptEntry[], id: string, delta: string): TranscriptEntry[] { return entries.map((entry) => entry.kind === "tool" && entry.id === id ? { ...entry, output: entry.output + delta } : entry); }
function describeTool(item: any, status: "in-progress" | "completed"): Extract<TranscriptEntry, { kind: "tool" }> {
  if (item.type === "commandExecution") return { kind: "tool", id: item.id, title: "Command", target: item.command, output: item.aggregatedOutput ?? "", status };
  if (item.type === "fileChange") return { kind: "tool", id: item.id, title: "File change", target: item.changes?.map((change: any) => change.path).join(", ") || "Workspace", output: item.changes?.map((change: any) => change.diff).join("\n") || "", status };
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") return { kind: "tool", id: item.id, title: item.tool, target: item.server ?? item.namespace ?? "tool", output: JSON.stringify(item.result ?? item.contentItems ?? "", null, 2), status };
  return { kind: "tool", id: item.id, title: item.type, target: item.path ?? item.query ?? "", output: "", status };
}
function projectTranscript(turns: any[]): TranscriptEntry[] {
  return turns.flatMap((turn) => turn.items.flatMap((item: any) => {
    if (item.type === "userMessage") return [{ kind: "user", id: item.id, text: item.content.map((part: any) => part.text ?? "").join("") }];
    if (item.type === "agentMessage") return [{ kind: "assistant", id: item.id, text: item.text }];
    if (item.type === "reasoning" && (item.summary.length || item.content.length)) return [{ kind: "reasoning", id: item.id, text: [...item.summary, ...item.content].join("\n") }];
    if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "imageView", "imageGeneration"].includes(item.type)) return [describeTool(item, "completed")];
    return [];
  })) as TranscriptEntry[];
}
function formatTime(timestamp: number): string { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(timestamp * 1000)); }

if (typeof document !== "undefined" && document.getElementById("root")) createRoot(document.getElementById("root")!).render(<App />);
