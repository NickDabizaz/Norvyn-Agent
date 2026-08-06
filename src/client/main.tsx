import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Connection = "connecting" | "connected" | "disconnected";

function App() {
  const [connection, setConnection] = useState<Connection>("connecting");
  const [workspace, setWorkspace] = useState("Awaiting Workspace");

  useEffect(() => {
    const url = new URL(window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/socket";
    const socket = new WebSocket(url);

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as { type: string; status?: Connection; workspace?: string };
      if (message.type === "connection" && message.status && message.workspace) {
        setConnection(message.status);
        setWorkspace(message.workspace);
      }
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
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
