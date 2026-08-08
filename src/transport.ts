import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { InitializeParams } from "../schemas/InitializeParams.js";
import type { ServerNotificationEnvelope } from "../schemas/ServerNotificationEnvelope.js";
import type { ServerRequest } from "../schemas/ServerRequest.js";
import type { Thread } from "../schemas/v2/Thread.js";
import type { ThreadForkResponse } from "../schemas/v2/ThreadForkResponse.js";
import type { ThreadListParams } from "../schemas/v2/ThreadListParams.js";
import type { ThreadResumeResponse } from "../schemas/v2/ThreadResumeResponse.js";
import type { ThreadStartParams } from "../schemas/v2/ThreadStartParams.js";
import type { TurnStartParams } from "../schemas/v2/TurnStartParams.js";
import type { ThreadCapabilities } from "./protocol.js";
import { safeExecutablePath } from "./preflight.js";
import {
  decodeModelListResult,
  decodeProviderMessage,
  decodeThreadForkResult,
  decodeThreadListResult,
  decodeThreadResumeResult,
  decodeThreadStartResult,
  decodeTurnStartResult,
  type ProviderId,
} from "./provider-codec.js";

type RpcId = ProviderId;
type OutgoingRpcMessage = {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string; data?: unknown };
};
type PendingResponse = { resolve(value: unknown): void; reject(error: Error): void };

export interface Transport {
  startThread(workspace: string, model: string): Promise<string>;
  startTurn(threadId: string, text: string, model: string): Promise<string>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  answerRequest(id: RpcId, result: unknown): void;
  restart(): Promise<void>;
  close(): void;
  on(event: "notification", listener: (message: ServerNotificationEnvelope) => void): this;
  on(event: "request", listener: (message: ServerRequest) => void): this;
  on(event: "processExit", listener: () => void): this;
  on(event: "ready", listener: () => void): this;
  on(event: "unavailable", listener: (error: Error) => void): this;
  on(event: "diagnostic", listener: (message: string) => void): this;
}

export interface ThreadListOptions {
  cursor?: string;
  limit?: number;
  search?: string;
  archived?: boolean;
}

export interface ThreadPage {
  threads: Thread[];
  nextCursor?: string;
}

export interface ThreadStore {
  readonly capabilities: ThreadCapabilities;
  listThreads(options?: ThreadListOptions): Promise<ThreadPage>;
  resumeThread(threadId: string): Promise<ThreadResumeResponse>;
  renameThread(threadId: string, name: string): Promise<void>;
  pinThread(threadId: string, pinned: boolean): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  restoreThread(threadId: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  forkThread(threadId: string, lastTurnId?: string): Promise<ThreadForkResponse>;
}

export interface ModelSource {
  listModels(): Promise<string[]>;
}

const capabilities: ThreadCapabilities = {
  rename: true,
  pin: true,
  archive: true,
  restore: true,
  delete: true,
  branch: true,
};

export class CodexAdapter extends EventEmitter implements Transport, ThreadStore, ModelSource {
  readonly capabilities = capabilities;
  private process?: ChildProcessWithoutNullStreams;
  private readonly responses = new Map<RpcId, PendingResponse>();
  private nextId = 1;
  private ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private closing = false;
  private restartingManually = false;
  private restartFailures = 0;
  private isReady = false;
  private readonly knownThreads = new Set<string>();

  private constructor(
    private readonly command: string,
    private readonly args: string[],
  ) {
    super();
    this.ready = this.newReadyPromise();
    void this.launch();
  }

  static async connect(codexPath?: string): Promise<CodexAdapter> {
    const { command, args } = providerLaunch(process.env, process.platform, codexPath);
    const adapter = new CodexAdapter(command, args);
    await adapter.ready;
    return adapter;
  }

  async startThread(workspace: string, model: string): Promise<string> {
    const params: ThreadStartParams = {
      cwd: workspace,
      model,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      config: { sandbox_workspace_write: { writable_roots: [workspace], network_access: false } },
    };
    const result = decodeThreadStartResult(await this.request("thread/start", params));
    this.knownThreads.add(result.thread.id);
    return result.thread.id;
  }

  async startTurn(threadId: string, text: string, model: string): Promise<string> {
    const params: TurnStartParams = {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      model,
      summary: "detailed",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    };
    const result = decodeTurnStartResult(await this.request("turn/start", params));
    return result.turn.id;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  async listThreads(options: ThreadListOptions = {}): Promise<ThreadPage> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const cursor = decodeCursor(options.cursor);
    const collected: Thread[] = [];
    let phase = cursor.phase;
    let providerCursor = cursor.providerCursor;

    while (collected.length < limit) {
      const params: ThreadListParams = {
        cursor: providerCursor ?? null,
        limit: limit - collected.length,
        sortKey: "updated_at",
        sortDirection: "desc",
        searchTerm: options.search,
        archived: options.archived ?? false,
        isPinned: phase === "pinned",
      };
      const response = decodeThreadListResult(await this.request("thread/list", params));
      collected.push(...response.data);
      if (response.nextCursor)
        return {
          threads: collected,
          nextCursor: encodeCursor({ phase, providerCursor: response.nextCursor }),
        };
      if (phase === "pinned") {
        phase = "regular";
        providerCursor = undefined;
        continue;
      }
      break;
    }
    return { threads: collected };
  }

  async resumeThread(threadId: string): Promise<ThreadResumeResponse> {
    const result = decodeThreadResumeResult(await this.request("thread/resume", resumeParams(threadId)));
    this.knownThreads.add(threadId);
    return result;
  }

  async listModels(): Promise<string[]> {
    const models: string[] = [];
    let cursor: string | null = null;
    do {
      const response = decodeModelListResult(
        await this.request("model/list", {
          cursor,
          limit: 100,
          includeHidden: false,
        }),
      );
      models.push(...response.data.filter((model) => !model.hidden).map((model) => model.model));
      cursor = response.nextCursor;
    } while (cursor);
    return [...new Set(models)];
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    await this.request("thread/name/set", { threadId, name });
  }

  async pinThread(threadId: string, pinned: boolean): Promise<void> {
    await this.request("thread/metadata/update", { threadId, isPinned: pinned });
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.request("thread/archive", { threadId });
  }

  async restoreThread(threadId: string): Promise<void> {
    await this.request("thread/unarchive", { threadId });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.request("thread/delete", { threadId });
    this.knownThreads.delete(threadId);
  }

  async forkThread(threadId: string, lastTurnId?: string): Promise<ThreadForkResponse> {
    const result = decodeThreadForkResult(
      await this.request("thread/fork", {
        ...resumeParams(threadId),
        lastTurnId,
      }),
    );
    this.knownThreads.add(result.thread.id);
    return result;
  }

  answerRequest(id: RpcId, result: unknown): void {
    this.send({ id, result });
  }

  async restart(): Promise<void> {
    if (this.closing) throw new Error("Provider connection is closed.");
    this.restartingManually = true;
    this.restartFailures = 0;
    this.isReady = false;
    this.ready = this.newReadyPromise();
    const child = this.process;
    if (child && child.exitCode === null) child.kill();
    else void this.launch();
    await this.ready;
  }

  close(): void {
    this.closing = true;
    this.process?.kill();
    this.failPending(new Error("Provider connection closed."));
  }

  private newReadyPromise(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  private async launch(): Promise<void> {
    if (this.closing) return;
    const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.process = child;
    child.stderr.on("data", (chunk) => this.emit("diagnostic", chunk.toString()));
    createInterface({ input: child.stdout }).on("line", (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
        this.receive(decodeProviderMessage(parsed));
      } catch {
        if (!this.rejectMalformedResponse(parsed)) this.failPending(new ProviderBoundaryError());
        this.emit("diagnostic", "The Provider sent a malformed protocol message.");
      }
    });
    child.once("error", (error) => this.handleExit(error));
    child.once("exit", () => this.handleExit(new Error("Provider process exited unexpectedly.")));

    try {
      const params: InitializeParams = {
        clientInfo: { name: "norvyn", title: "Norvyn", version: "0.1.0" },
        capabilities: null,
      };
      await this.requestNow("initialize", params);
      this.send({ method: "initialized", params: {} });
      for (const threadId of this.knownThreads)
        await this.requestNow("thread/resume", resumeParams(threadId));
      this.restartFailures = 0;
      this.isReady = true;
      this.restartingManually = false;
      this.resolveReady();
      this.emit("ready");
    } catch (error) {
      if (this.process === child) this.handleExit(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleExit(error: Error): void {
    if (this.process) {
      this.process.removeAllListeners("exit");
      this.process.removeAllListeners("error");
      if (this.process.exitCode === null && !this.process.killed) this.process.kill();
      this.process = undefined;
    }
    const wasReady = this.isReady;
    this.isReady = false;
    this.failPending(error);
    if (this.closing) return;
    this.emit("processExit");
    this.restartFailures += 1;
    if (this.restartFailures > 3) {
      const unavailable = new Error("Provider could not be restarted after 3 attempts.");
      this.rejectReady(unavailable);
      this.emit("unavailable", unavailable);
      return;
    }
    if (wasReady && !this.restartingManually) this.ready = this.newReadyPromise();
    setTimeout(() => void this.launch(), 25 * this.restartFailures);
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    await this.ready;
    return this.requestNow(method, params);
  }

  private requestNow(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.responses.set(id, { resolve, reject });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.responses.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private send(message: OutgoingRpcMessage): void {
    if (!this.process?.stdin.writable) throw new Error("Provider process is unavailable.");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(message: ReturnType<typeof decodeProviderMessage>): void {
    if (message.kind === "request") {
      if (message.request) this.emit("request", message.request);
      else this.answerRequest(message.id, { decision: "decline" });
      return;
    }
    if (message.kind === "response") {
      const pending = this.responses.get(message.id);
      if (pending) {
        this.responses.delete(message.id);
        if (message.error) pending.reject(providerError(message.error));
        else pending.resolve(message.result);
      }
      return;
    }
    if (message.notification) this.emit("notification", message.notification);
  }

  private failPending(error: Error): void {
    for (const pending of this.responses.values()) pending.reject(error);
    this.responses.clear();
  }

  private rejectMalformedResponse(input: unknown): boolean {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    const value = input as Record<string, unknown>;
    if (value.method !== undefined) return false;
    if (typeof value.id !== "number" && typeof value.id !== "string") return false;
    const pending = this.responses.get(value.id);
    if (!pending) return false;
    this.responses.delete(value.id);
    pending.reject(new ProviderBoundaryError());
    return true;
  }
}

interface CompoundCursor {
  phase: "pinned" | "regular";
  providerCursor?: string;
}

function encodeCursor(cursor: CompoundCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(cursor?: string): CompoundCursor {
  if (!cursor) return { phase: "pinned" };
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CompoundCursor;
    if (parsed.phase !== "pinned" && parsed.phase !== "regular") throw new Error("bad phase");
    return parsed;
  } catch {
    throw new Error("History cursor is invalid or stale.");
  }
}

function resumeParams(threadId: string) {
  return { threadId, approvalPolicy: "on-request" as const, approvalsReviewer: "user" as const };
}

export class ProviderBoundaryError extends Error {
  constructor() {
    super("The Provider rejected this request. Check your setup and retry.");
    this.name = "ProviderBoundaryError";
  }
}

function providerError(_error: { message: string; data?: unknown }): Error {
  return new ProviderBoundaryError();
}

export function providerLaunch(
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  codexPath?: string,
): { command: string; args: string[] } {
  if (environment.NORVYN_PROVIDER_COMMAND) {
    return {
      command: environment.NORVYN_PROVIDER_COMMAND,
      args: environment.NORVYN_PROVIDER_ARGUMENTS
        ? (JSON.parse(environment.NORVYN_PROVIDER_ARGUMENTS) as string[])
        : ["app-server"],
    };
  }
  const executable = codexPath?.trim() || "codex";
  if (platform === "win32") {
    const quoted = safeExecutablePath(executable);
    return { command: environment.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `${quoted} app-server`] };
  }
  return { command: executable, args: ["app-server"] };
}
