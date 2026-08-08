import type { ServerRequest } from "../schemas/ServerRequest.js";
import type { ThreadItem } from "../schemas/v2/ThreadItem.js";
import type { Turn } from "../schemas/v2/Turn.js";

export type AccessMode = "manual" | "auto-edit" | "auto";
export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export type ProviderProcessStatus =
  "missing" | "signed-out" | "connecting" | "connected" | "disconnected" | "failed";
export type TextScale = "small" | "medium" | "large";
export type TranscriptDensity = "comfortable" | "compact";
export type OperationScope =
  | "turn"
  | "workspace"
  | "workspace-history"
  | "provider"
  | "authorization"
  | "settings"
  | "update"
  | "chat"
  | "protocol";
export type RecoveryAction =
  "retry" | "reconnect-provider" | "open-settings" | "choose-workspace" | "choose-model";

export interface ChatState {
  id: string;
  threadId?: string;
  workspace?: string;
  model?: string;
  modelNotice?: string;
  accessMode: AccessMode;
  turnId?: string;
  origin?: { threadId: string; turnId?: string; label: string };
}

export interface ThreadCapabilities {
  rename: boolean;
  pin: boolean;
  archive: boolean;
  restore: boolean;
  delete: boolean;
  branch: boolean;
}

export interface ThreadSummary {
  id: string;
  title: string;
  preview: string;
  workspace: string;
  updatedAt: number;
  createdAt: number;
  pinned: boolean;
  archived: boolean;
}

export interface UserSettings {
  version: 1;
  defaultModel?: string;
  customModels: string[];
  codexPath?: string;
  versionChecks: boolean;
  textScale: TextScale;
  transcriptDensity: TranscriptDensity;
}

export interface DiagnosticsReport {
  norvynVersion: string;
  codexPath: string;
  codexVersion?: string;
  localSession: "available" | "missing" | "expired" | "unknown";
  providerProcess: ProviderProcessStatus;
  connection: ConnectionStatus;
  nextAction?: string;
  generatedAt: string;
}

export type BrowserCommand =
  | { type: "history/list"; cursor?: string; search?: string; archived?: boolean }
  | { type: "chat/new"; workspace?: string }
  | { type: "chat/open"; threadId: string }
  | { type: "chat/workspace"; chatId: string; workspace: string }
  | { type: "chat/workspace/browse"; chatId: string }
  | { type: "chat/model"; chatId: string; model: string }
  | { type: "chat/access-mode"; chatId: string; accessMode: AccessMode }
  | { type: "chat/branch"; chatId: string; turnId?: string; text?: string; label: string }
  | { type: "thread/rename"; threadId: string; name: string }
  | { type: "thread/pin"; threadId: string; pinned: boolean }
  | { type: "thread/archive"; threadId: string }
  | { type: "thread/restore"; threadId: string }
  | { type: "thread/delete"; threadId: string; confirmed: true }
  | { type: "history/workspace/archive"; workspace: string }
  | { type: "history/workspace/delete"; workspace: string; confirmed?: true }
  | { type: "turn/start"; chatId?: string; text: string; requestId?: string }
  | { type: "turn/interrupt"; chatId: string }
  | { type: "approval/respond"; requestId: number | string; approved: boolean }
  | { type: "auth/connect" }
  | { type: "provider/disconnect" }
  | { type: "provider/reconnect" }
  | { type: "provider/restart" }
  | { type: "settings/get" }
  | { type: "settings/save"; settings: UserSettings }
  | { type: "diagnostics/get" }
  | { type: "diagnostics/export" }
  | { type: "update/dismiss"; version: string }
  | { type: "update/prepare"; version: string }
  | { type: "update/start"; version: string; confirmed: true };

export type ServerEvent =
  | {
      type: "connection";
      status: ConnectionStatus;
      workspace: string;
      models?: string[];
      unverifiedModels?: string[];
      modelError?: string;
      chat?: ChatState;
      providerStatus: ProviderProcessStatus;
      capabilities: ThreadCapabilities;
      workspaceBrowseAvailable: boolean;
    }
  | {
      type: "operation/error";
      scope: OperationScope;
      code: string;
      message: string;
      recovery?: RecoveryAction;
    }
  | { type: "preflight/failed"; kind: "missing" | "outdated"; message: string }
  | {
      type: "auth/state";
      status: "required" | "connecting" | "failed" | "cancelled" | "timed-out" | "connected";
      message?: string;
    }
  | {
      type: "history/page";
      threads: ThreadSummary[];
      workspaces: string[];
      nextCursor?: string;
      archived: boolean;
      reset: boolean;
    }
  | {
      type: "history/changed";
      threadId: string;
      action: "renamed" | "pinned" | "unpinned" | "archived" | "restored" | "deleted";
    }
  | {
      type: "history/workspace/removed";
      workspace: string;
      threadIds: string[];
      count: number;
      action: "archived" | "deleted";
    }
  | { type: "chat/selected"; chat: ChatState; transcript: Turn[] }
  | { type: "chat/updated"; chat: ChatState }
  | { type: "chat/branched"; chat: ChatState; transcript: Turn[] }
  | { type: "workspace/browse/cancelled" }
  | { type: "turn/accepted"; chatId: string; requestId?: string }
  | { type: "turn/started"; chatId: string; threadId: string; turnId: string; text: string }
  | { type: "turn/interrupted"; chatId: string }
  | { type: "turn/failed"; chatId: string; message: string }
  | { type: "turn/completed"; chatId?: string; threadId?: string; turn?: Turn }
  | {
      type: "turn/error";
      message: string;
      chatId?: string;
      threadId: string;
      turnId?: unknown;
      terminal: boolean;
    }
  | { type: "agent/message/delta"; threadId: string; turnId: string; itemId: string; delta: string }
  | { type: "reasoning/delta"; threadId: string; turnId: string; itemId: string; delta: string }
  | {
      type: "tool/activity";
      threadId: string;
      turnId: string;
      item: ThreadItem;
      status: "in-progress" | "completed";
    }
  | { type: "tool/output/delta"; threadId: string; turnId: string; itemId: string; delta: string }
  | {
      type: "approval/request";
      requestId: number | string;
      chatId?: string;
      kind: "file-change" | "command-execution";
      target: string;
    }
  | { type: "approval/expired"; requestId: number | string }
  | { type: "provider/state"; status: ProviderProcessStatus; message?: string }
  | {
      type: "settings/state";
      settings: UserSettings;
      models: string[];
      unverifiedModels: string[];
      modelError?: string;
      warning?: string;
      providerStatus: ProviderProcessStatus;
    }
  | {
      type: "settings/saved";
      settings: UserSettings;
      models: string[];
      unverifiedModels: string[];
      modelError?: string;
    }
  | { type: "settings/error"; message: string }
  | { type: "diagnostics/state"; report: DiagnosticsReport }
  | { type: "diagnostics/export"; filename: string; content: string }
  | { type: "update/available"; installed: string; available: string }
  | { type: "update/prepared"; version: string; command: string }
  | { type: "update/progress"; line: string }
  | { type: "update/completed"; version: string; restartRequired: true }
  | { type: "update/failed"; version: string; message: string };

export class ProtocolDecodeError extends Error {
  constructor(
    readonly code: "invalid-json" | "invalid-shape" | "unknown-type" | "invalid-field",
    message: string,
  ) {
    super(message);
    this.name = "ProtocolDecodeError";
  }
}

export function parseBrowserCommand(input: unknown): BrowserCommand {
  const value = objectValue(input, "Browser command");
  const type = stringValue(value.type, "type");
  switch (type) {
    case "history/list":
      return {
        type,
        cursor: optionalString(value.cursor, "cursor"),
        search: optionalString(value.search, "search"),
        archived: optionalBoolean(value.archived, "archived"),
      };
    case "chat/new":
      return { type, workspace: optionalString(value.workspace, "workspace") };
    case "chat/open":
      return { type, threadId: stringValue(value.threadId, "threadId") };
    case "chat/workspace":
      return {
        type,
        chatId: stringValue(value.chatId, "chatId"),
        workspace: stringValue(value.workspace, "workspace"),
      };
    case "chat/workspace/browse":
    case "turn/interrupt":
      return { type, chatId: stringValue(value.chatId, "chatId") };
    case "chat/model":
      return {
        type,
        chatId: stringValue(value.chatId, "chatId"),
        model: stringValue(value.model, "model"),
      };
    case "chat/access-mode":
      return {
        type,
        chatId: stringValue(value.chatId, "chatId"),
        accessMode: enumValue(value.accessMode, "accessMode", ["manual", "auto-edit", "auto"]),
      };
    case "chat/branch":
      return {
        type,
        chatId: stringValue(value.chatId, "chatId"),
        turnId: optionalString(value.turnId, "turnId"),
        text: optionalString(value.text, "text"),
        label: stringValue(value.label, "label"),
      };
    case "thread/rename":
      return {
        type,
        threadId: stringValue(value.threadId, "threadId"),
        name: stringValue(value.name, "name"),
      };
    case "thread/pin":
      return {
        type,
        threadId: stringValue(value.threadId, "threadId"),
        pinned: booleanValue(value.pinned, "pinned"),
      };
    case "thread/archive":
    case "thread/restore":
      return { type, threadId: stringValue(value.threadId, "threadId") };
    case "thread/delete":
      return {
        type,
        threadId: stringValue(value.threadId, "threadId"),
        confirmed: trueValue(value.confirmed, "confirmed"),
      };
    case "history/workspace/archive":
      return { type, workspace: stringValue(value.workspace, "workspace") };
    case "history/workspace/delete":
      return {
        type,
        workspace: stringValue(value.workspace, "workspace"),
        confirmed: optionalTrue(value.confirmed, "confirmed"),
      };
    case "turn/start":
      return {
        type,
        chatId: optionalString(value.chatId, "chatId"),
        text: stringValue(value.text, "text"),
        requestId: optionalString(value.requestId, "requestId"),
      };
    case "approval/respond":
      return {
        type,
        requestId: identifierValue(value.requestId, "requestId"),
        approved: booleanValue(value.approved, "approved"),
      };
    case "settings/save":
      return { type, settings: userSettingsValue(value.settings) };
    case "update/dismiss":
    case "update/prepare":
      return { type, version: stringValue(value.version, "version") };
    case "update/start":
      return {
        type,
        version: stringValue(value.version, "version"),
        confirmed: trueValue(value.confirmed, "confirmed"),
      };
    case "auth/connect":
    case "provider/disconnect":
    case "provider/reconnect":
    case "provider/restart":
    case "settings/get":
    case "diagnostics/get":
    case "diagnostics/export":
      return { type };
    default:
      throw new ProtocolDecodeError("unknown-type", "The browser sent an unsupported operation.");
  }
}

const eventTypes = new Set<ServerEvent["type"]>([
  "connection",
  "operation/error",
  "preflight/failed",
  "auth/state",
  "history/page",
  "history/changed",
  "history/workspace/removed",
  "chat/selected",
  "chat/updated",
  "chat/branched",
  "workspace/browse/cancelled",
  "turn/accepted",
  "turn/started",
  "turn/interrupted",
  "turn/failed",
  "turn/completed",
  "turn/error",
  "agent/message/delta",
  "reasoning/delta",
  "tool/activity",
  "tool/output/delta",
  "approval/request",
  "approval/expired",
  "provider/state",
  "settings/state",
  "settings/saved",
  "settings/error",
  "diagnostics/state",
  "diagnostics/export",
  "update/available",
  "update/prepared",
  "update/progress",
  "update/completed",
  "update/failed",
]);

export function parseServerEvent(input: unknown): ServerEvent {
  const value = objectValue(input, "Server event");
  const type = stringValue(value.type, "type");
  if (!eventTypes.has(type as ServerEvent["type"]))
    throw new ProtocolDecodeError("unknown-type", "Norvyn received an unsupported server event.");

  switch (type as ServerEvent["type"]) {
    case "connection":
      enumValue(value.status, "status", ["connecting", "connected", "disconnected"]);
      stringValue(value.workspace, "workspace");
      enumValue(value.providerStatus, "providerStatus", [
        "missing",
        "signed-out",
        "connecting",
        "connected",
        "disconnected",
        "failed",
      ]);
      objectValue(value.capabilities, "capabilities");
      booleanValue(value.workspaceBrowseAvailable, "workspaceBrowseAvailable");
      optionalStringArray(value.models, "models");
      optionalStringArray(value.unverifiedModels, "unverifiedModels");
      optionalString(value.modelError, "modelError");
      break;
    case "operation/error":
      enumValue(value.scope, "scope", [
        "turn",
        "workspace",
        "workspace-history",
        "provider",
        "authorization",
        "settings",
        "update",
        "chat",
        "protocol",
      ]);
      stringValue(value.code, "code");
      stringValue(value.message, "message");
      if (value.recovery !== undefined)
        enumValue(value.recovery, "recovery", [
          "retry",
          "reconnect-provider",
          "open-settings",
          "choose-workspace",
          "choose-model",
        ]);
      break;
    case "preflight/failed":
      enumValue(value.kind, "kind", ["missing", "outdated"]);
      stringValue(value.message, "message");
      break;
    case "auth/state":
      enumValue(value.status, "status", [
        "required",
        "connecting",
        "failed",
        "cancelled",
        "timed-out",
        "connected",
      ]);
      optionalString(value.message, "message");
      break;
    case "history/page":
      arrayValue(value.threads, "threads");
      stringArray(value.workspaces, "workspaces");
      optionalString(value.nextCursor, "nextCursor");
      booleanValue(value.archived, "archived");
      booleanValue(value.reset, "reset");
      break;
    case "history/changed":
      stringValue(value.threadId, "threadId");
      enumValue(value.action, "action", ["renamed", "pinned", "unpinned", "archived", "restored", "deleted"]);
      break;
    case "history/workspace/removed":
      stringValue(value.workspace, "workspace");
      stringArray(value.threadIds, "threadIds");
      numberValue(value.count, "count");
      enumValue(value.action, "action", ["archived", "deleted"]);
      break;
    case "chat/selected":
    case "chat/branched":
      chatValue(value.chat);
      arrayValue(value.transcript, "transcript");
      break;
    case "chat/updated":
      chatValue(value.chat);
      break;
    case "workspace/browse/cancelled":
      break;
    case "turn/accepted":
      stringValue(value.chatId, "chatId");
      optionalString(value.requestId, "requestId");
      break;
    case "turn/started":
      stringValue(value.chatId, "chatId");
      stringValue(value.threadId, "threadId");
      stringValue(value.turnId, "turnId");
      stringValue(value.text, "text");
      break;
    case "turn/interrupted":
      stringValue(value.chatId, "chatId");
      break;
    case "turn/failed":
      stringValue(value.chatId, "chatId");
      stringValue(value.message, "message");
      break;
    case "turn/completed":
      optionalString(value.chatId, "chatId");
      optionalString(value.threadId, "threadId");
      if (value.turn !== undefined) objectValue(value.turn, "turn");
      break;
    case "turn/error":
      stringValue(value.message, "message");
      optionalString(value.chatId, "chatId");
      stringValue(value.threadId, "threadId");
      booleanValue(value.terminal, "terminal");
      break;
    case "agent/message/delta":
    case "reasoning/delta":
    case "tool/output/delta":
      stringValue(value.threadId, "threadId");
      stringValue(value.turnId, "turnId");
      stringValue(value.itemId, "itemId");
      stringValue(value.delta, "delta");
      break;
    case "tool/activity":
      stringValue(value.threadId, "threadId");
      stringValue(value.turnId, "turnId");
      objectValue(value.item, "item");
      enumValue(value.status, "status", ["in-progress", "completed"]);
      break;
    case "approval/request":
      identifierValue(value.requestId, "requestId");
      optionalString(value.chatId, "chatId");
      enumValue(value.kind, "kind", ["file-change", "command-execution"]);
      stringValue(value.target, "target");
      break;
    case "approval/expired":
      identifierValue(value.requestId, "requestId");
      break;
    case "provider/state":
      enumValue(value.status, "status", [
        "missing",
        "signed-out",
        "connecting",
        "connected",
        "disconnected",
        "failed",
      ]);
      optionalString(value.message, "message");
      break;
    case "settings/state":
    case "settings/saved":
      userSettingsValue(value.settings);
      stringArray(value.models, "models");
      stringArray(value.unverifiedModels, "unverifiedModels");
      optionalString(value.modelError, "modelError");
      if (type === "settings/state") {
        optionalString(value.warning, "warning");
        enumValue(value.providerStatus, "providerStatus", [
          "missing",
          "signed-out",
          "connecting",
          "connected",
          "disconnected",
          "failed",
        ]);
      }
      break;
    case "settings/error":
      stringValue(value.message, "message");
      break;
    case "diagnostics/state":
      objectValue(value.report, "report");
      break;
    case "diagnostics/export":
      stringValue(value.filename, "filename");
      stringValue(value.content, "content");
      break;
    case "update/available":
      stringValue(value.installed, "installed");
      stringValue(value.available, "available");
      break;
    case "update/prepared":
      stringValue(value.version, "version");
      stringValue(value.command, "command");
      break;
    case "update/progress":
      stringValue(value.line, "line");
      break;
    case "update/completed":
      stringValue(value.version, "version");
      trueValue(value.restartRequired, "restartRequired");
      break;
    case "update/failed":
      stringValue(value.version, "version");
      stringValue(value.message, "message");
      break;
  }
  return value as unknown as ServerEvent;
}

function userSettingsValue(input: unknown): UserSettings {
  const value = objectValue(input, "settings");
  if (value.version !== 1) invalidField("settings.version", "must be 1");
  const result: UserSettings = {
    version: 1,
    customModels: stringArray(value.customModels, "settings.customModels"),
    versionChecks: booleanValue(value.versionChecks, "settings.versionChecks"),
    textScale: enumValue(value.textScale, "settings.textScale", ["small", "medium", "large"]),
    transcriptDensity: enumValue(value.transcriptDensity, "settings.transcriptDensity", [
      "comfortable",
      "compact",
    ]),
  };
  const defaultModel = optionalString(value.defaultModel, "settings.defaultModel");
  const codexPath = optionalString(value.codexPath, "settings.codexPath");
  if (defaultModel !== undefined) result.defaultModel = defaultModel;
  if (codexPath !== undefined) result.codexPath = codexPath;
  return result;
}

function chatValue(input: unknown): void {
  const value = objectValue(input, "chat");
  stringValue(value.id, "chat.id");
  optionalString(value.threadId, "chat.threadId");
  optionalString(value.workspace, "chat.workspace");
  optionalString(value.model, "chat.model");
  optionalString(value.modelNotice, "chat.modelNotice");
  enumValue(value.accessMode, "chat.accessMode", ["manual", "auto-edit", "auto"]);
  optionalString(value.turnId, "chat.turnId");
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProtocolDecodeError("invalid-shape", `${field} must be an object.`);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalidField(field, "must be an array");
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) invalidField(field, "must be a non-empty string");
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return stringValue(value, field);
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalidField(field, "must be true or false");
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  return value === undefined || value === null ? undefined : booleanValue(value, field);
}

function trueValue(value: unknown, field: string): true {
  if (value !== true) invalidField(field, "must be true");
  return true;
}

function optionalTrue(value: unknown, field: string): true | undefined {
  return value === undefined || value === null ? undefined : trueValue(value, field);
}

function numberValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalidField(field, "must be a finite number");
  return value;
}

function identifierValue(value: unknown, field: string): number | string {
  if ((typeof value !== "number" && typeof value !== "string") || value === "")
    invalidField(field, "must be an identifier");
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  return arrayValue(value, field).map((entry, index) => stringValue(entry, `${field}[${index}]`));
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  return value === undefined || value === null ? undefined : stringArray(value, field);
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  field: string,
  values: Values,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value))
    invalidField(field, `must be one of ${values.join(", ")}`);
  return value as Values[number];
}

function invalidField(field: string, expectation: string): never {
  throw new ProtocolDecodeError("invalid-field", `Invalid ${field}: ${expectation}.`);
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled protocol variant: ${typeof value}`);
}

export type ProviderApprovalRequest = ServerRequest;
