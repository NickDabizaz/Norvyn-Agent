import type { JsonValue } from "../schemas/serde_json/JsonValue.js";
import type { ThreadItem } from "../schemas/v2/ThreadItem.js";

export interface ClaudeToolCall {
  id: string;
  tool: string;
  arguments: JsonValue;
}

/**
 * The Claude Code CLI's stdio stream, reduced to what Norvyn acts on. Everything else the CLI emits —
 * hook lifecycle, session init, rate-limit notices — decodes to nothing rather than to a loose object,
 * so no feature logic runs on an unvalidated payload.
 */
export type ClaudeEvent =
  | { kind: "text"; itemId: string; text: string }
  | { kind: "reasoning"; itemId: string; text: string }
  | { kind: "userMessage"; itemId: string; text: string }
  | { kind: "toolStarted"; call: ClaudeToolCall }
  | { kind: "toolResult"; id: string; output: string; success: boolean }
  /** `denied` names the tools the Provider refused to run under the Turn's Access Mode. */
  | { kind: "result"; error?: string; denied: string[] };

/**
 * Decodes one line of the Provider's stream. One line can carry several events, because a single
 * assistant message may hold text, reasoning, and tool calls at once.
 */
export function decodeClaudeEvents(input: unknown): ClaudeEvent[] {
  const value = record(input);
  if (!value) return [];
  if (value.type === "result")
    return [{ kind: "result", error: resultError(value), denied: deniedTools(value) }];
  if (value.type !== "assistant" && value.type !== "user") return [];

  const message = record(value.message);
  const messageId = text(message?.id) ?? text(value.uuid) ?? "";
  const content = Array.isArray(message?.content) ? message.content : [];
  const events: ClaudeEvent[] = [];

  content.forEach((entry, index) => {
    const block = record(entry);
    if (!block) return;
    const itemId = `${messageId || "item"}:${index}`;
    if (block.type === "text") {
      const body = text(block.text);
      if (!body) return;
      events.push(
        value.type === "user"
          ? { kind: "userMessage", itemId, text: body }
          : { kind: "text", itemId, text: body },
      );
    } else if (block.type === "thinking") {
      const body = text(block.thinking);
      if (body) events.push({ kind: "reasoning", itemId, text: body });
    } else if (block.type === "tool_use") {
      const id = text(block.id);
      const tool = text(block.name);
      if (id && tool) events.push({ kind: "toolStarted", call: { id, tool, arguments: json(block.input) } });
    } else if (block.type === "tool_result") {
      const id = text(block.tool_use_id);
      if (id)
        events.push({
          kind: "toolResult",
          id,
          output: flatten(block.content),
          success: block.is_error !== true,
        });
    }
  });
  return events;
}

/**
 * Renders one Claude tool call as the Provider-neutral tool item the browser already knows how to
 * display. `dynamicToolCall` is used for every tool because Claude's tool set is open-ended.
 */
export function claudeToolItem(
  call: ClaudeToolCall,
  status: "inProgress" | "completed" | "failed" = "inProgress",
  output?: string,
): ThreadItem {
  return {
    type: "dynamicToolCall",
    id: call.id,
    namespace: null,
    tool: call.tool,
    arguments: call.arguments,
    status,
    contentItems: output === undefined ? null : [{ type: "inputText", text: output }],
    success: status === "inProgress" ? null : status === "completed",
    durationMs: null,
  };
}

/**
 * Tool calls the Provider refused. Only the tool's name is taken — its arguments can carry Workspace
 * content, and nothing downstream needs them to explain the refusal.
 */
function deniedTools(value: Record<string, unknown>): string[] {
  if (!Array.isArray(value.permission_denials)) return [];
  const names = value.permission_denials.map((entry) => text(record(entry)?.tool_name)).filter(Boolean);
  return [...new Set(names as string[])];
}

function resultError(value: Record<string, unknown>): string | undefined {
  if (value.is_error !== true) return undefined;
  return text(value.result) ?? text(value.subtype) ?? "The Provider reported a failed Turn.";
}

/** Tool results arrive as a string or as a list of content blocks; both flatten to displayable text. */
function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => text(record(entry)?.text) ?? "")
    .filter(Boolean)
    .join("\n");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function json(value: unknown): JsonValue {
  return (value ?? null) as JsonValue;
}
