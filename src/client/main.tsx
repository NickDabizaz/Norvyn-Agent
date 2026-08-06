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

  useEffect(() => {
    const url = new URL(window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/socket";
    const socket = new WebSocket(url);
    setSocket(socket);

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as { type: string; status?: Connection; workspace?: string; delta?: string };
      if (message.type === "connection" && message.status && message.workspace) {
        setConnection(message.status);
        setWorkspace(message.workspace);
      }
      if (message.type === "agent/message/delta") setReply((current) => current + String(message.delta ?? ""));
      if (message.type === "turn/completed") setTurnState("complete");
    };
    socket.onclose = () => setConnection("disconnected");
    socket.onerror = () => setConnection("disconnected");

    return () => socket.close();
  }, []);

  return (
    <main className="console">
      <section className="masthead" aria-label="Norvyn status">
        <p className="eyebrow">LOCAL AGENT CONSOLE / 01</p>
        <h1>NORVYN<span>_</span></h1>
        <div className={`signal signal--${connection}`}>
          <i aria-hidden="true" />
          <span>{connection}</span>
        </div>
      </section>

      <section className="workspace-card" aria-live="polite">
        <p className="label">ACTIVE WORKSPACE</p>
        <p className="workspace">{workspace}</p>
        <p className="caption">This local connection is ready for a Provider.</p>
      </section>
      <section className="chat" aria-label="Chat">
        <p className="label">FIRST TURN</p>
        {reply && <p className="reply">{reply}</p>}
        {turnState === "complete" && <p className="caption">Turn complete.</p>}
        <form onSubmit={(event) => { event.preventDefault(); if (draft.trim()) { setReply(""); setTurnState("running"); socket?.send(JSON.stringify({ type: "turn/start", text: draft })); setDraft(""); } }}>
          <label htmlFor="prompt">Start a Turn</label>
          <textarea id="prompt" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Ask Codex about this Workspace…" />
          <button type="submit" disabled={connection !== "connected"}>Send Turn</button>
        </form>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
