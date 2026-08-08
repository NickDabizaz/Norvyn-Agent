import { useEffect, useEffectEvent } from "react";
import type { OperationScope, ServerEvent } from "../protocol.js";
import { parseServerEvent } from "../protocol.js";
import { reconnectDelay } from "./windowing.js";

export interface BrowserConnectionCallbacks {
  onEvent(event: ServerEvent): void;
  onSocket(socket: WebSocket): void;
  onStatus(status: "connecting" | "disconnected"): void;
  onBoundaryError(error: {
    scope: OperationScope;
    code: string;
    message: string;
    recovery?: "reconnect-provider";
  }): void;
}

export function useBrowserConnection(retryNonce: number, callbacks: BrowserConnectionCallbacks): void {
  const onEvent = useEffectEvent(callbacks.onEvent);
  const onSocket = useEffectEvent(callbacks.onSocket);
  const onStatus = useEffectEvent(callbacks.onStatus);
  const onBoundaryError = useEffectEvent(callbacks.onBoundaryError);

  useEffect(() => {
    let connectionSocket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let attempt = 0;

    async function authorize(): Promise<void> {
      const access = new URLSearchParams(window.location.hash.slice(1)).get("access");
      if (!access) return;
      const response = await fetch("/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ access }),
      });
      window.history.replaceState(null, "", window.location.pathname);
      if (!response.ok) throw new Error("Norvyn could not authorize this local browser.");
    }

    function connect(): void {
      if (disposed) return;
      onStatus("connecting");
      const url = new URL(window.location.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = "/socket";
      connectionSocket = new WebSocket(url);
      onSocket(connectionSocket);
      connectionSocket.onopen = () => {
        attempt = 0;
      };
      connectionSocket.onmessage = (event) => {
        try {
          onEvent(parseServerEvent(JSON.parse(event.data)));
        } catch {
          onBoundaryError({
            scope: "protocol",
            code: "protocol.invalid-server-event",
            message: "Norvyn received an invalid local server event. Reconnect to continue.",
            recovery: "reconnect-provider",
          });
        }
      };
      connectionSocket.onclose = () => {
        if (disposed) return;
        onStatus("disconnected");
        reconnectTimer = setTimeout(connect, reconnectDelay(attempt++));
      };
      connectionSocket.onerror = () => connectionSocket?.close();
    }

    void authorize()
      .then(connect)
      .catch(() => {
        onStatus("disconnected");
        onBoundaryError({
          scope: "authorization",
          code: "authorization.denied",
          message: "Norvyn could not authorize this local browser.",
        });
      });
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      connectionSocket?.close();
    };
  }, [retryNonce]);
}
