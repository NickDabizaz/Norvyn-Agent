import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Connection = "connecting" | "connected" | "disconnected";

function App() {
  const [connection, setConnection] = useState<Connection>("connecting");
  const [workspace, setWorkspace] = useState("Awaiting Workspace");
  const [reply, setReply] = useState("");
  const [draft, setDraft] = useState("");
  const [socket, setSocket] = useState<WebSocket>();
  const [turnState, setTurnState] = useState<"idle" | "running" | "complete">("idle");
  const [preflightError, setPreflightError] = useState<string>();

  useEffect(() => {
    const url = new URL(window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/socket";
    const socket = new WebSocket(url);
    setSocket(socket);

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as { type: string; status?: Connection; workspace?: string; delta?: string; message?: string };
      if (message.type === "connection" && message.status && message.workspace) {
        setConnection(message.status);
        setWorkspace(message.workspace);
      }
      if (message.type === "agent/message/delta") setReply((current) => current + String(message.delta ?? ""));
      if (message.type === "turn/completed") setTurnState("complete");
      if (message.type === "preflight/failed") setPreflightError(String(message.message ?? "Norvyn cannot reach Codex."));
    };
    socket.onclose = () => setConnection("disconnected");
    socket.onerror = () => setConnection("disconnected");

    return () => socket.close();
  }, []);

  return (
    <main className="app-shell">
      <header className="topbar" aria-label="Norvyn status">
        <a className="wordmark" href="/" aria-label="Norvyn home">NORVYN<span>.</span></a>
        <div className={`connection connection--${connection}`}>
          <i aria-hidden="true" />
          <span>{connection}</span>
        </div>
      </header>

      <section className="workbench">
        <div className="workspace-bar" aria-live="polite">
          <div>
            <p className="eyebrow">WORKSPACE</p>
            <p className="workspace">{workspace}</p>
          </div>
          <p className="workspace-state">{preflightError ? "Provider unavailable" : "Provider ready"}</p>
        </div>

        {preflightError && (
          <aside className="preflight-alert" aria-live="assertive">
            <p className="eyebrow">SETUP REQUIRED</p>
            <p>{preflightError}</p>
          </aside>
        )}

        <section className="chat" aria-label="Chat">
          <div className="chat-heading">
            <div>
              <p className="eyebrow">CHAT / 01</p>
              <h1>Start a Turn</h1>
            </div>
            {turnState === "running" && <span className="turn-state">Responding</span>}
            {turnState === "complete" && <span className="turn-state">Complete</span>}
          </div>

          <div className="conversation" aria-live="polite">
            {reply ? <p className="reply">{reply}</p> : <p className="empty-state">Ask Codex to inspect, explain, or change something in this Workspace.</p>}
          </div>

          <form className="composer" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) { setReply(""); setTurnState("running"); socket?.send(JSON.stringify({ type: "turn/start", text: draft })); setDraft(""); } }}>
            <label className="sr-only" htmlFor="prompt">Your Turn</label>
            <textarea id="prompt" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Ask Codex about this Workspace…" />
            <button type="submit" disabled={connection !== "connected"}>Send <span>Turn</span></button>
          </form>
        </section>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
