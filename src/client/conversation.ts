import type { ThreadItem } from "../../schemas/v2/ThreadItem.js";
import type { Turn } from "../../schemas/v2/Turn.js";
import type { ServerEvent } from "../protocol.js";

export type TranscriptEntry =
  | { kind: "user"; id: string; turnId?: string; previousTurnId?: string; text: string; complete?: boolean }
  | {
      kind: "assistant";
      id: string;
      turnId?: string;
      previousTurnId?: string;
      text: string;
      complete?: boolean;
    }
  | { kind: "error"; id: string; text: string }
  | { kind: "reasoning"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      title: string;
      target: string;
      output: string;
      status: "in-progress" | "completed";
    };

export function failTurnTranscript(
  entries: TranscriptEntry[],
  message: string,
  id: string = crypto.randomUUID(),
): TranscriptEntry[] {
  const last = entries.at(-1);
  const completed = last?.kind === "assistant" && !last.text ? entries.slice(0, -1) : entries;
  return [...completed, { kind: "error", id, text: message }];
}

export function appendAssistantDelta(entries: TranscriptEntry[], delta: string): TranscriptEntry[] {
  let index = -1;
  for (let position = entries.length - 1; position >= 0; position -= 1)
    if (entries[position].kind === "assistant") {
      index = position;
      break;
    }
  if (index < 0)
    return [...entries, { kind: "assistant", id: crypto.randomUUID(), text: delta, complete: false }];
  return entries.map((entry, position) =>
    position === index && entry.kind === "assistant" ? { ...entry, text: entry.text + delta } : entry,
  );
}

export function appendReasoningDelta(
  entries: TranscriptEntry[],
  id: string,
  delta: string,
): TranscriptEntry[] {
  const found = entries.findIndex((entry) => entry.kind === "reasoning" && entry.id === id);
  if (found < 0) {
    let pendingAssistant = -1;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.kind === "assistant" && entry.complete === false) {
        pendingAssistant = index;
        break;
      }
    }
    if (pendingAssistant < 0) return [...entries, { kind: "reasoning", id, text: delta }];
    return [
      ...entries.slice(0, pendingAssistant),
      { kind: "reasoning", id, text: delta },
      ...entries.slice(pendingAssistant),
    ];
  }
  return entries.map((entry, index) =>
    index === found && entry.kind === "reasoning" ? { ...entry, text: entry.text + delta } : entry,
  );
}

export function upsertTool(
  entries: TranscriptEntry[],
  item: ThreadItem,
  status: "in-progress" | "completed",
): TranscriptEntry[] {
  const tool = describeTool(item, status);
  const found = entries.findIndex((entry) => entry.kind === "tool" && entry.id === tool.id);
  return found < 0
    ? [...entries, tool]
    : entries.map((entry, index) =>
        index === found && entry.kind === "tool"
          ? { ...entry, ...tool, output: tool.output || entry.output }
          : entry,
      );
}

export function appendToolOutput(entries: TranscriptEntry[], id: string, delta: string): TranscriptEntry[] {
  return entries.map((entry) =>
    entry.kind === "tool" && entry.id === id ? { ...entry, output: entry.output + delta } : entry,
  );
}

export function describeTool(
  item: ThreadItem,
  status: "in-progress" | "completed",
): Extract<TranscriptEntry, { kind: "tool" }> {
  const record = item as unknown as Record<string, unknown>;
  const id = String(record.id ?? crypto.randomUUID());
  if (item.type === "commandExecution")
    return {
      kind: "tool",
      id,
      title: "Command",
      target: String(record.command ?? ""),
      output: String(record.aggregatedOutput ?? ""),
      status,
    };
  if (item.type === "fileChange") {
    const changes = Array.isArray(record.changes) ? (record.changes as Record<string, unknown>[]) : [];
    return {
      kind: "tool",
      id,
      title: "File change",
      target: changes.map((change) => String(change.path ?? "")).join(", ") || "Workspace",
      output: changes.map((change) => String(change.diff ?? "")).join("\n"),
      status,
    };
  }
  return {
    kind: "tool",
    id,
    title: item.type,
    target: String(record.server ?? record.namespace ?? record.path ?? record.query ?? ""),
    output:
      typeof record.result === "string"
        ? record.result
        : record.result
          ? JSON.stringify(record.result, null, 2)
          : "",
    status,
  };
}

export function projectTranscript(turns: Turn[]): TranscriptEntry[] {
  let previousTurnId: string | undefined;
  const entries: TranscriptEntry[] = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === "userMessage")
        entries.push({
          kind: "user",
          id: item.id,
          turnId: turn.id,
          previousTurnId,
          text: item.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
          complete: true,
        });
      else if (item.type === "agentMessage")
        entries.push({
          kind: "assistant",
          id: item.id,
          turnId: turn.id,
          previousTurnId,
          text: item.text,
          complete: true,
        });
      else if (item.type === "reasoning") {
        const record = item as unknown as { summary?: string[]; content?: string[] };
        const text = [...(record.summary ?? []), ...(record.content ?? [])].join("\n");
        if (text) entries.push({ kind: "reasoning", id: item.id, text });
      } else if (
        [
          "commandExecution",
          "fileChange",
          "mcpToolCall",
          "dynamicToolCall",
          "webSearch",
          "imageView",
          "imageGeneration",
        ].includes(item.type)
      )
        entries.push(describeTool(item, "completed"));
    }
    previousTurnId = turn.id;
  }
  return entries;
}

export function lastCompletedTurnId(entries: TranscriptEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if ((entry.kind === "assistant" || entry.kind === "user") && entry.turnId && entry.complete)
      return entry.turnId;
  }
  return undefined;
}

export function isTranscriptEvent(event: ServerEvent): boolean {
  return [
    "agent/message/delta",
    "reasoning/delta",
    "tool/activity",
    "tool/output/delta",
    "turn/completed",
    "turn/error",
  ].includes(event.type);
}
