import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { InitializeParams } from "../schemas/InitializeParams.js";
import type { ModelListResponse } from "../schemas/v2/ModelListResponse.js";
import type { ServerNotificationEnvelope } from "../schemas/ServerNotificationEnvelope.js";
import type { ServerRequest } from "../schemas/ServerRequest.js";
import type { Thread } from "../schemas/v2/Thread.js";
import type { ThreadListParams } from "../schemas/v2/ThreadListParams.js";
import type { ThreadListResponse } from "../schemas/v2/ThreadListResponse.js";
import type { ThreadResumeResponse } from "../schemas/v2/ThreadResumeResponse.js";
import type { ThreadStartParams } from "../schemas/v2/ThreadStartParams.js";
import type { TurnStartParams } from "../schemas/v2/TurnStartParams.js";

type RpcId = number | string;
type RpcMessage = { id?: RpcId; method?: string; params?: unknown; result?: unknown; error?: { message: string; data?: unknown } };
type PendingResponse = { resolve(value: unknown): void; reject(error: Error): void };

export interface Transport {
  startThread(workspace: string, model: string): Promise<string>;
  startTurn(threadId: string, text: string, model: string): Promise<string>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  answerRequest(id: RpcId, result: unknown): void;
  close(): void;
  on(event: "notification", listener: (message: ServerNotificationEnvelope) => void): this;
  on(event: "request", listener: (message: ServerRequest) => void): this;
  on(event: "processExit", listener: () => void): this;
  on(event: "unavailable", listener: (error: Error) => void): this;
  on(event: "diagnostic", listener: (message: string) => void): this;
}

export interface ThreadStore {
  listThreads(searchTerm?: string): Promise<Thread[]>;
  resumeThread(threadId: string): Promise<ThreadResumeResponse>;
}

export interface ModelSource {
  listModels(): Promise<string[]>;
}

export interface ThreadOrganizer {
  archiveThread(threadId: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
}

export class CodexAdapter extends EventEmitter implements Transport, ThreadStore, ModelSource, ThreadOrganizer {
  private process?: ChildProcessWithoutNullStreams;
  private readonly responses = new Map<RpcId, PendingResponse>();
  private nextId = 1;
  private ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private closing = false;
  private restartFailures = 0;
  private isReady = false;
  private readonly knownThreads = new Set<string>();

  private constructor(private readonly command: string, private readonly args: string[]) {
    super();
    this.ready = this.newReadyPromise();
    void this.launch();
  }

  static async connect(): Promise<CodexAdapter> {
    const { command, args } = providerLaunch();
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
    const result = await this.request("thread/start", params) as { thread: { id: string } };
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
    const result = await this.request("turn/start", params) as { turn: { id: string } };
    return result.turn.id;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  async listThreads(searchTerm?: string): Promise<Thread[]> {
    const threads: Thread[] = [];
    let cursor: string | null = null;
    do {
      const params: ThreadListParams = { cursor, limit: 100, sortKey: "updated_at", sortDirection: "desc", searchTerm };
      const response = await this.request("thread/list", params) as ThreadListResponse;
      threads.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor);
    return threads.sort((a, b) => (b.recencyAt ?? b.updatedAt) - (a.recencyAt ?? a.updatedAt));
  }

  async resumeThread(threadId: string): Promise<ThreadResumeResponse> {
    const result = await this.request("thread/resume", { threadId, approvalPolicy: "on-request", approvalsReviewer: "user" }) as ThreadResumeResponse;
    this.knownThreads.add(threadId);
    return result;
  }

  async listModels(): Promise<string[]> {
    const models: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await this.request("model/list", { cursor, limit: 100, includeHidden: false }) as ModelListResponse;
      models.push(...response.data.filter((model) => !model.hidden).map((model) => model.model));
      cursor = response.nextCursor;
    } while (cursor);
    return [...new Set(models)];
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.request("thread/archive", { threadId });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.request("thread/delete", { threadId });
    this.knownThreads.delete(threadId);
  }

  answerRequest(id: RpcId, result: unknown): void { this.send({ id, result }); }

  close(): void {
    this.closing = true;
    this.process?.kill();
    this.failPending(new Error("Provider connection closed."));
  }

  private newReadyPromise(): Promise<void> {
    return new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
  }

  private async launch(): Promise<void> {
    if (this.closing) return;
    const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.process = child;
    child.stderr.on("data", (chunk) => this.emit("diagnostic", chunk.toString()));
    createInterface({ input: child.stdout }).on("line", (line) => {
      try { this.receive(JSON.parse(line) as RpcMessage); }
      catch (error) { this.emit("diagnostic", `Invalid Provider message: ${String(error)}`); }
    });
    child.once("error", (error) => this.handleExit(error));
    child.once("exit", () => this.handleExit(new Error("Provider process exited unexpectedly.")));

    try {
      const params: InitializeParams = { clientInfo: { name: "norvyn", title: "Norvyn", version: "0.1.0" }, capabilities: null };
      await this.requestNow("initialize", params);
      this.send({ method: "initialized", params: {} });
      for (const threadId of this.knownThreads) await this.requestNow("thread/resume", { threadId, approvalPolicy: "on-request", approvalsReviewer: "user" });
      this.restartFailures = 0;
      this.isReady = true;
      this.resolveReady();
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
    if (wasReady) this.ready = this.newReadyPromise();
    setTimeout(() => void this.launch(), 25 * this.restartFailures);
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    await this.ready;
    return this.requestNow(method, params);
  }

  private requestNow(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.send({ id, method, params });
    return new Promise((resolve, reject) => this.responses.set(id, { resolve, reject }));
  }

  private send(message: RpcMessage): void {
    if (!this.process?.stdin.writable) throw new Error("Provider process is unavailable.");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(message: RpcMessage): void {
    if (message.id !== undefined && message.method) {
      this.emit("request", message as ServerRequest);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.responses.get(message.id);
      if (pending) {
        this.responses.delete(message.id);
        if (message.error) pending.reject(providerError(message.error)); else pending.resolve(message.result);
      }
      return;
    }
    if (message.method) this.emit("notification", message as ServerNotificationEnvelope);
  }

  private failPending(error: Error): void {
    for (const pending of this.responses.values()) pending.reject(error);
    this.responses.clear();
  }
}

function providerError(error: { message: string; data?: unknown }): Error {
  const result = new Error(error.message);
  Object.assign(result, { data: error.data });
  return result;
}

export function providerLaunch(environment: NodeJS.ProcessEnv = process.env, platform = process.platform): { command: string; args: string[] } {
  if (environment.NORVYN_PROVIDER_COMMAND) {
    return {
      command: environment.NORVYN_PROVIDER_COMMAND,
      args: environment.NORVYN_PROVIDER_ARGUMENTS ? JSON.parse(environment.NORVYN_PROVIDER_ARGUMENTS) as string[] : ["app-server"],
    };
  }
  if (platform === "win32") return { command: environment.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "codex app-server"] };
  return { command: "codex", args: ["app-server"] };
}
