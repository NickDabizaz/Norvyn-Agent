import { useEffect, useMemo, useRef, useState } from "react";
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
  const [approval, setApproval] = useState<Approval>();
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [historyWidth, setHistoryWidth] = useState<number | undefined>(() => {
    const stored = sessionStorage.getItem("norvyn.historyWidth");
    return stored ? Number(stored) : undefined;
  });
  const layout = useRef<HTMLElement>(null);
  const chatRef = useRef<Chat | undefined>(undefined);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/socket";
    const connectionSocket = new WebSocket(url);
    setSocket(connectionSocket);
    connectionSocket.onmessage = (event) => handleServerEvent(JSON.parse(event.data));
    connectionSocket.onclose = () => setConnection("disconnected");
    connectionSocket.onerror = () => setConnection("disconnected");
    return () => connectionSocket.close();
  }, []);

  const visibleThreads = useMemo(() => filterThreads(threads, search), [threads, search]);

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
    } else if (message.type === "chat/selected") {
      chatRef.current = message.chat;
      setChat(message.chat);
      setTranscript(projectTranscript(message.transcript));
      setShowWorkspacePicker(false);
    } else if (message.type === "chat/updated") {
      chatRef.current = message.chat;
      setChat(message.chat);
      setShowWorkspacePicker(false);
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
    } else if (message.type === "turn/error" || message.type === "error" || message.type === "provider/unavailable") {
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
    <main ref={layout} className="app-shell" style={{ gridTemplateColumns: historyWidth ? `${historyWidth}px 7px minmax(420px, 1fr)` : "minmax(220px, 20%) 7px minmax(420px, 80%)" }}>
      <aside className="history" aria-label="History">
        <header className="brand"><span>NORVYN_</span><i className={`signal signal--${connection}`} title={connection} /></header>
        <button className="new-chat" onClick={() => transmit({ type: "chat/new" })}>＋ New Chat</button>
        <label className="search"><span>Search Chats</span><input aria-label="Search Chats" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search history…" /></label>
        <nav className="thread-list" aria-label="Past Chats">
          {visibleThreads.map((thread) => <button key={thread.id} className={thread.id === chat?.threadId ? "active" : ""} onClick={() => transmit({ type: "chat/open", threadId: thread.id })}>
            <strong>{thread.title}</strong><small>{thread.workspace}</small><time>{formatTime(thread.updatedAt)}</time>
          </button>)}
          {!visibleThreads.length && <p className="empty">No Chats found.</p>}
        </nav>
      </aside>
      <div className="divider" role="separator" aria-label="Resize History" aria-orientation="vertical" onPointerDown={resize}><span /></div>
      <section className="chat-panel" aria-label="Chat">
        <header className="chat-toolbar">
          <div>{chat?.workspace ? <button className="workspace-path" onClick={() => setShowWorkspacePicker(true)}>{chat.workspace}</button> : <button onClick={() => setShowWorkspacePicker(true)}>Connect Folder</button>}</div>
          <div className="selectors">
            <label>Model<select aria-label="Model" value={chat?.model ?? ""} onChange={(event) => chat && transmit({ type: "chat/model", chatId: chat.id, model: event.target.value })}>{models.map((model) => <option key={model}>{model}</option>)}</select></label>
            <label>Access Mode<select aria-label="Access Mode" value={chat?.accessMode ?? "manual"} onChange={(event) => chat && transmit({ type: "chat/access-mode", chatId: chat.id, accessMode: event.target.value })}><option value="manual">Manual</option><option value="auto-edit">Auto Edit</option><option value="auto">Auto</option></select></label>
          </div>
        </header>

        {showWorkspacePicker && <section className="workspace-picker" aria-label="Workspace picker">
          <h2>Connect Folder</h2>
          {workspaces.map((candidate) => <button key={candidate} onClick={() => chat && transmit({ type: "chat/workspace", chatId: chat.id, workspace: candidate })}>{candidate}</button>)}
          <form onSubmit={(event) => { event.preventDefault(); if (chat && workspaceDraft.trim()) transmit({ type: "chat/workspace", chatId: chat.id, workspace: workspaceDraft }); }}><input aria-label="Workspace path" value={workspaceDraft} onChange={(event) => setWorkspaceDraft(event.target.value)} placeholder="Enter an absolute path" /><button>Connect</button></form>
          <button className="quiet" onClick={() => setShowWorkspacePicker(false)}>Cancel</button>
        </section>}

        <div className="transcript" aria-live="polite">
          {preflightError ? <aside className="preflight-alert" aria-live="assertive"><p className="eyebrow">SETUP REQUIRED</p><p>{preflightError}</p></aside> : !transcript.length && <div className="welcome"><p className="eyebrow">LOCAL AGENT / READY</p><h1>What are we<br />building?</h1><p>Your Chat stays on this machine and inside its Workspace Boundary.</p></div>}
          {transcript.map((entry) => entry.kind === "reasoning" ? <details className="reasoning" key={entry.id}><summary>Reasoning</summary><pre>{entry.text}</pre></details> : entry.kind === "tool" ? <details className={`tool tool--${entry.status}`} key={entry.id}><summary><span>{entry.title}</span><code>{entry.target}</code><i>{entry.status}</i></summary><pre>{entry.output || "Waiting for output…"}</pre></details> : <article key={entry.id} className={`message message--${entry.kind}`}><span>{entry.kind}</span><p>{entry.text || (entry.kind === "assistant" ? "Thinking…" : "")}</p></article>)}
        </div>

        {approval && <section className="approval"><strong>{approval.kind === "file-change" ? "File change requested" : "Command requested"}</strong><code>{approval.target}</code><div><button onClick={() => { transmit({ type: "approval/respond", requestId: approval.requestId, approved: false }); setApproval(undefined); }}>Decline</button><button onClick={() => { transmit({ type: "approval/respond", requestId: approval.requestId, approved: true }); setApproval(undefined); }}>Approve</button></div></section>}

        <form className="composer" onSubmit={(event) => { event.preventDefault(); if (chat && draft.trim()) { transmit({ type: "turn/start", chatId: chat.id, text: draft }); setDraft(""); } }}>
          <textarea aria-label="Start a Turn" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={chat?.workspace ? "Ask about this Workspace…" : "Connect Folder to begin…"} disabled={!chat?.workspace || connection !== "connected"} />
          {chat?.turnId ? <button type="button" className="stop" onClick={() => transmit({ type: "turn/interrupt", chatId: chat.id })}>Stop</button> : <button type="submit" disabled={!draft.trim() || !chat?.workspace || connection !== "connected"}>Send</button>}
        </form>
      </section>
    </main>
  );
}

export function filterThreads(threads: HistoryThread[], search: string): HistoryThread[] {
  const query = search.trim().toLocaleLowerCase();
  return query ? threads.filter((thread) => thread.title.toLocaleLowerCase().includes(query) || thread.preview.toLocaleLowerCase().includes(query)) : threads;
}
export function clampPaneWidth(requested: number, total: number): number { return Math.min(Math.max(requested, 220), Math.max(220, total - 420)); }

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
