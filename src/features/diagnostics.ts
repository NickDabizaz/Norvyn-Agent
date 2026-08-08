import type { DiagnosticsReport, ProviderKind, ProviderProcessStatus } from "../protocol.js";

const providerLabel: Record<ProviderKind, string> = { openai: "Codex CLI", anthropic: "Claude Code" };
const connectLabel: Record<ProviderKind, string> = { openai: "Codex", anthropic: "Claude" };

const sensitiveKey = /(token|secret|password|credential|api[-_]?key|authorization|cookie)/i;

export function createDiagnostics(input: {
  norvynVersion: string;
  provider: ProviderKind;
  providerPath: string;
  providerVersion?: string;
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
  if (input.providerProcess === "missing") return `Install ${providerLabel[input.provider]}, then reconnect.`;
  if (input.localSession === "missing" || input.localSession === "expired")
    return `Connect With ${connectLabel[input.provider]} again.`;
  if (input.providerProcess === "failed") return "Restart the Provider and inspect the new result.";
  if (input.connection === "disconnected") return "Reconnect the Provider.";
  return undefined;
}
