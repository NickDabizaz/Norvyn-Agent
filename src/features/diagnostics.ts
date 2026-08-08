import type { DiagnosticsReport, ProviderProcessStatus } from "../protocol.js";

const sensitiveKey = /(token|secret|password|credential|api[-_]?key|authorization|cookie)/i;

export function createDiagnostics(input: {
  norvynVersion: string;
  codexPath: string;
  codexVersion?: string;
  localSession: DiagnosticsReport["localSession"];
  providerProcess: ProviderProcessStatus;
  connection: DiagnosticsReport["connection"];
}): DiagnosticsReport {
  return { ...input, nextAction: nextAction(input), generatedAt: new Date().toISOString() };
}

export function sanitizedDiagnosticExport(
  report: DiagnosticsReport,
  additional: Record<string, unknown> = {},
): string {
  return JSON.stringify(sanitize({ report, additional }), null, 2);
}

export function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !sensitiveKey.test(key))
      .map(([key, entry]) => [key, sanitize(entry)]),
  );
}

function nextAction(input: Omit<DiagnosticsReport, "generatedAt" | "nextAction">): string | undefined {
  if (input.providerProcess === "missing") return "Install Codex CLI, then reconnect.";
  if (input.localSession === "missing" || input.localSession === "expired")
    return "Connect With Codex again.";
  if (input.providerProcess === "failed") return "Restart the Provider and inspect the new result.";
  if (input.connection === "disconnected") return "Reconnect the Provider.";
  return undefined;
}
