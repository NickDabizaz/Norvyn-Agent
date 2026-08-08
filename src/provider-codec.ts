import type { ServerNotificationEnvelope } from "../schemas/ServerNotificationEnvelope.js";
import type { ServerRequest } from "../schemas/ServerRequest.js";
import type { Thread } from "../schemas/v2/Thread.js";
import type { ThreadForkResponse } from "../schemas/v2/ThreadForkResponse.js";
import type { ThreadListResponse } from "../schemas/v2/ThreadListResponse.js";
import type { ThreadResumeResponse } from "../schemas/v2/ThreadResumeResponse.js";
import type { Turn } from "../schemas/v2/Turn.js";

export type ProviderId = number | string;
export type DecodedProviderMessage =
  | { kind: "response"; id: ProviderId; result?: unknown; error?: { message: string; data?: unknown } }
  | { kind: "request"; request?: ServerRequest; id: ProviderId }
  | { kind: "notification"; notification?: ServerNotificationEnvelope };

const notificationMethods = new Set([
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/started",
  "item/completed",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "turn/completed",
  "error",
  "thread/name/updated",
  "thread/archived",
  "thread/unarchived",
  "thread/deleted",
]);

export function decodeProviderMessage(input: unknown): DecodedProviderMessage {
  const value = record(input, "Provider message");
  const id = optionalId(value.id, "id");
  const method = optionalText(value.method, "method");
  if (id !== undefined && method) {
    const params = record(value.params, "params");
    return { kind: "request", id, request: decodeProviderRequest(id, method, params) };
  }
  if (id !== undefined) {
    if (value.error !== undefined) {
      const error = record(value.error, "error");
      return {
        kind: "response",
        id,
        error: { message: nonEmpty(error.message, "error.message"), data: error.data },
      };
    }
    if (!("result" in value)) invalid("result", "is required for a successful response");
    return { kind: "response", id, result: value.result };
  }
  if (!method) invalid("method", "is required for a notification");
  const params = record(value.params, "params");
  return {
    kind: "notification",
    notification: notificationMethods.has(method) ? decodeNotification(method, params) : undefined,
  };
}

export function decodeThreadStartResult(input: unknown): { thread: { id: string } } {
  const value = record(input, "thread/start result");
  const thread = record(value.thread, "thread/start result.thread");
  return { thread: { id: nonEmpty(thread.id, "thread/start result.thread.id") } };
}

export function decodeTurnStartResult(input: unknown): { turn: { id: string } } {
  const value = record(input, "turn/start result");
  const turn = record(value.turn, "turn/start result.turn");
  return { turn: { id: nonEmpty(turn.id, "turn/start result.turn.id") } };
}

export function decodeThreadListResult(input: unknown): ThreadListResponse {
  const value = record(input, "thread/list result");
  const data = array(value.data, "thread/list result.data").map((thread, index) =>
    decodeThread(thread, `thread/list result.data[${index}]`),
  );
  const nextCursor = nullableText(value.nextCursor, "thread/list result.nextCursor");
  const backwardsCursor = nullableText(value.backwardsCursor, "thread/list result.backwardsCursor");
  return { data, nextCursor, backwardsCursor };
}

export function decodeThreadResumeResult(input: unknown): ThreadResumeResponse {
  return decodeThreadOperationResult(input, "thread/resume result") as ThreadResumeResponse;
}

export function decodeThreadForkResult(input: unknown): ThreadForkResponse {
  return decodeThreadOperationResult(input, "thread/fork result") as ThreadForkResponse;
}

export function decodeModelListResult(input: unknown): {
  data: { model: string; hidden: boolean }[];
  nextCursor: string | null;
} {
  const value = record(input, "model/list result");
  const data = array(value.data, "model/list result.data").map((entry, index) => {
    const model = record(entry, `model/list result.data[${index}]`);
    return {
      model: nonEmpty(model.model, `model/list result.data[${index}].model`),
      hidden: boolean(model.hidden, `model/list result.data[${index}].hidden`),
    };
  });
  return { data, nextCursor: nullableText(value.nextCursor, "model/list result.nextCursor") };
}

function decodeThreadOperationResult(
  input: unknown,
  field: string,
): ThreadResumeResponse | ThreadForkResponse {
  const value = record(input, field);
  decodeThread(value.thread, `${field}.thread`);
  nonEmpty(value.model, `${field}.model`);
  nonEmpty(value.modelProvider, `${field}.modelProvider`);
  nullableText(value.serviceTier, `${field}.serviceTier`);
  nonEmpty(value.cwd, `${field}.cwd`);
  array(value.instructionSources, `${field}.instructionSources`).forEach((source, index) =>
    nonEmpty(source, `${field}.instructionSources[${index}]`),
  );
  nonEmpty(value.approvalPolicy, `${field}.approvalPolicy`);
  nonEmpty(value.approvalsReviewer, `${field}.approvalsReviewer`);
  record(value.sandbox, `${field}.sandbox`);
  nullableText(value.reasoningEffort, `${field}.reasoningEffort`);
  return value as unknown as ThreadResumeResponse | ThreadForkResponse;
}

function decodeThread(input: unknown, field: string): Thread {
  const value = record(input, field);
  nonEmpty(value.id, `${field}.id`);
  nonEmpty(value.sessionId, `${field}.sessionId`);
  nullableText(value.forkedFromId, `${field}.forkedFromId`);
  nullableText(value.parentThreadId, `${field}.parentThreadId`);
  text(value.preview, `${field}.preview`);
  boolean(value.ephemeral, `${field}.ephemeral`);
  boolean(value.isPinned, `${field}.isPinned`);
  nonEmpty(value.modelProvider, `${field}.modelProvider`);
  finiteNumber(value.createdAt, `${field}.createdAt`);
  finiteNumber(value.updatedAt, `${field}.updatedAt`);
  nullableNumber(value.recencyAt, `${field}.recencyAt`);
  const status = record(value.status, `${field}.status`);
  enumText(status.type, `${field}.status.type`, ["notLoaded", "idle", "systemError", "active"]);
  nullableText(value.path, `${field}.path`);
  nonEmpty(value.cwd, `${field}.cwd`);
  nonEmpty(value.cliVersion, `${field}.cliVersion`);
  if (typeof value.source !== "string") record(value.source, `${field}.source`);
  nullableText(value.threadSource, `${field}.threadSource`);
  nullableText(value.agentNickname, `${field}.agentNickname`);
  nullableText(value.agentRole, `${field}.agentRole`);
  if (value.gitInfo !== null) record(value.gitInfo, `${field}.gitInfo`);
  nullableText(value.name, `${field}.name`);
  array(value.turns, `${field}.turns`).forEach((turn, index) => decodeTurn(turn, `${field}.turns[${index}]`));
  return value as unknown as Thread;
}

function decodeTurn(input: unknown, field: string): Turn {
  const value = record(input, field);
  nonEmpty(value.id, `${field}.id`);
  array(value.items, `${field}.items`).forEach((item, index) =>
    decodeThreadItem(item, `${field}.items[${index}]`),
  );
  enumText(value.itemsView, `${field}.itemsView`, ["notLoaded", "summary", "full"]);
  enumText(value.status, `${field}.status`, ["completed", "interrupted", "failed", "inProgress"]);
  if (value.error !== null) record(value.error, `${field}.error`);
  nullableNumber(value.startedAt, `${field}.startedAt`);
  nullableNumber(value.completedAt, `${field}.completedAt`);
  nullableNumber(value.durationMs, `${field}.durationMs`);
  return value as unknown as Turn;
}

function decodeThreadItem(input: unknown, field: string): void {
  const value = record(input, field);
  const type = nonEmpty(value.type, `${field}.type`);
  const known = [
    "userMessage",
    "hookPrompt",
    "agentMessage",
    "plan",
    "reasoning",
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "dynamicToolCall",
    "collabAgentToolCall",
    "subAgentActivity",
    "webSearch",
    "imageView",
    "sleep",
    "imageGeneration",
    "enteredReviewMode",
    "exitedReviewMode",
    "contextCompaction",
  ];
  if (!known.includes(type)) invalid(`${field}.type`, "is unsupported");
  if ("id" in value) nonEmpty(value.id, `${field}.id`);
  if (type === "userMessage")
    array(value.content, `${field}.content`).forEach((part, index) => {
      const content = record(part, `${field}.content[${index}]`);
      const contentType = nonEmpty(content.type, `${field}.content[${index}].type`);
      if (contentType === "text") text(content.text, `${field}.content[${index}].text`);
    });
  if (type === "agentMessage" || type === "plan") text(value.text, `${field}.text`);
  if (type === "reasoning") {
    stringArray(value.summary, `${field}.summary`);
    stringArray(value.content, `${field}.content`);
  }
  if (type === "commandExecution") nonEmpty(value.command, `${field}.command`);
  if (type === "fileChange") array(value.changes, `${field}.changes`);
}

function decodeProviderRequest(
  id: ProviderId,
  method: string,
  params: Record<string, unknown>,
): ServerRequest | undefined {
  if (method !== "item/commandExecution/requestApproval" && method !== "item/fileChange/requestApproval")
    return undefined;
  nonEmpty(params.threadId, "params.threadId");
  nonEmpty(params.turnId, "params.turnId");
  nonEmpty(params.itemId, "params.itemId");
  finiteNumber(params.startedAtMs, "params.startedAtMs");
  if (method === "item/commandExecution/requestApproval") {
    nullableText(params.environmentId, "params.environmentId");
    optionalNullableText(params.command, "params.command");
    optionalNullableText(params.reason, "params.reason");
  } else {
    optionalNullableText(params.grantRoot, "params.grantRoot");
    optionalNullableText(params.reason, "params.reason");
  }
  return { id, method, params } as ServerRequest;
}

function decodeNotification(method: string, params: Record<string, unknown>): ServerNotificationEnvelope {
  if (
    method === "item/agentMessage/delta" ||
    method === "item/reasoning/summaryTextDelta" ||
    method === "item/reasoning/textDelta" ||
    method === "item/commandExecution/outputDelta" ||
    method === "item/fileChange/outputDelta"
  ) {
    nonEmpty(params.threadId, "params.threadId");
    nonEmpty(params.turnId, "params.turnId");
    nonEmpty(params.itemId, "params.itemId");
    text(params.delta, "params.delta");
  } else if (method === "item/started" || method === "item/completed") {
    nonEmpty(params.threadId, "params.threadId");
    nonEmpty(params.turnId, "params.turnId");
    decodeThreadItem(params.item, "params.item");
  } else if (method === "turn/completed") {
    nonEmpty(params.threadId, "params.threadId");
    decodeTurn(params.turn, "params.turn");
  } else if (method === "error") {
    nonEmpty(params.threadId, "params.threadId");
    nonEmpty(params.turnId, "params.turnId");
    boolean(params.willRetry, "params.willRetry");
    const error = record(params.error, "params.error");
    nonEmpty(error.message, "params.error.message");
  } else {
    nonEmpty(params.threadId, "params.threadId");
  }
  return { method, params } as ServerNotificationEnvelope;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field, "must be an object");
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field, "must be an array");
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") invalid(field, "must be a string");
  return value;
}

function nonEmpty(value: unknown, field: string): string {
  const result = text(value, field);
  if (!result.trim()) invalid(field, "must not be empty");
  return result;
}

function optionalText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : nonEmpty(value, field);
}

function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : nonEmpty(value, field);
}

function optionalNullableText(value: unknown, field: string): string | null | undefined {
  return value === undefined ? undefined : nullableText(value, field);
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(field, "must be true or false");
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(field, "must be a finite number");
  return value;
}

function nullableNumber(value: unknown, field: string): number | null {
  return value === null ? null : finiteNumber(value, field);
}

function optionalId(value: unknown, field: string): ProviderId | undefined {
  if (value === undefined) return undefined;
  if ((typeof value !== "number" && typeof value !== "string") || value === "")
    invalid(field, "must be an identifier");
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  return array(value, field).map((entry, index) => text(entry, `${field}[${index}]`));
}

function enumText(value: unknown, field: string, options: readonly string[]): string {
  const result = nonEmpty(value, field);
  if (!options.includes(result)) invalid(field, `must be one of ${options.join(", ")}`);
  return result;
}

function invalid(field: string, expectation: string): never {
  throw new Error(`Invalid Provider ${field}: ${expectation}.`);
}
