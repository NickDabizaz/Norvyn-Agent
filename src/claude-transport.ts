import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ServerNotificationEnvelope } from "../schemas/ServerNotificationEnvelope.js";
import type { ThreadItem } from "../schemas/v2/ThreadItem.js";
import type { Turn } from "../schemas/v2/Turn.js";
import { safeExecutablePath } from "./preflight.js";
import type { ReasoningEffort, TurnAttachment } from "./protocol.js";
import { NorvynThreadStore, type StoredThread } from "./thread-store.js";
import type { ModelSource, ThreadStore, Transport } from "./transport.js";
import { claudeToolItem, decodeClaudeEvents, type ClaudeToolCall } from "./claude-codec.js";

/**
 * Models Norvyn offers for the Claude Provider. The Claude Code CLI accepts `--model` but exposes no
 * way to enumerate what a subscription may use, so this is a curated catalog rather than discovery;
 * anything outside it goes through the unverified-custom-model path in User Settings. See ADR-0005.
 */
export const CLAUDE_MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"] as const;

export type ClaudePermissionMode = "manual" | "acceptEdits" | "bypassPermissions";

export interface ClaudeAdapterOptions {
  claudePath?: string;
  /**
   * Chosen once per process, because the CLI takes it as a launch flag. Defaults to `manual`, matching
   * the CONTEXT.md rule that a Thread is Manual until deliberately raised.
   */
  permissionMode?: ClaudePermissionMode;
  /** Directory holding the Provider's rollout files. Defaults to `~/.claude/projects`. */
  rolloutRoot?: string;
}

interface ThreadProcess {
  threadId: string;
  workspace: string;
  model: string;
  effort: ReasoningEffort;
  /** True once the CLI has accepted this Thread, so later launches must `--resume` rather than create. */
  persisted: boolean;
  process?: ChildProcessWithoutNullStreams;
  turnId?: string;
  turnItems: ThreadItem[];
  turnStartedAt?: number;
  /** Tool calls awaiting their result, which arrives on a later line carrying only the call's id. */
  pendingTools: Map<string, ClaudeToolCall>;
}

/**
 * The Claude Transport: one headless `claude` process per Thread, speaking newline-delimited JSON over
 * stdio, translated into the Provider-neutral notifications the rest of Norvyn already consumes.
 * History is delegated to a Norvyn-owned {@link NorvynThreadStore} because Claude Code exposes none.
 */
export class ClaudeAdapter extends EventEmitter implements Transport, ThreadStore, ModelSource {
  private readonly threads = new Map<string, ThreadProcess>();
  private readonly store: NorvynThreadStore;
  private readonly claudePath: string;
  private readonly permissionMode: ClaudePermissionMode;
  private readonly rolloutRoot: string;
  private closing = false;

  private constructor(options: ClaudeAdapterOptions) {
    super();
    this.claudePath = options.claudePath?.trim() || "claude";
    this.permissionMode = options.permissionMode ?? "manual";
    this.rolloutRoot = options.rolloutRoot ?? join(homedir(), ".claude", "projects");
    this.store = new NorvynThreadStore({
      modelProvider: "anthropic",
      readTranscript: (thread) => this.readTranscript(thread),
    });
  }

  get capabilities() {
    return this.store.capabilities;
  }

  /**
   * Unlike the Codex app-server there is no handshake to await: a Claude process exists only while a
   * Thread is active, so the Adapter is usable the moment it is constructed.
   */
  static connect(options: ClaudeAdapterOptions = {}): Promise<ClaudeAdapter> {
    const adapter = new ClaudeAdapter(options);
    queueMicrotask(() => adapter.emit("ready"));
    return Promise.resolve(adapter);
  }

  listModels(): Promise<string[]> {
    return Promise.resolve([...CLAUDE_MODELS]);
  }

  async startThread(workspace: string, model: string): Promise<string> {
    const threadId = randomUUID();
    this.threads.set(threadId, {
      threadId,
      workspace,
      model,
      effort: "medium",
      persisted: false,
      turnItems: [],
      pendingTools: new Map(),
    });
    await this.store.record({ id: threadId, workspace, model, preview: "" });
    return threadId;
  }

  async startTurn(
    threadId: string,
    text: string,
    model: string,
    effort: ReasoningEffort,
    attachments: TurnAttachment[] = [],
  ): Promise<string> {
    const thread = await this.threadProcess(threadId);
    if (thread.turnId) throw new Error("A Turn is already running in this Chat.");
    // Model and effort are launch flags, so changing either means relaunching against the same thread.
    if (thread.model !== model || thread.effort !== effort) {
      thread.model = model;
      thread.effort = effort;
      this.stop(thread);
    }
    this.ensureProcess(thread);
    const turnId = randomUUID();
    thread.turnId = turnId;
    thread.turnItems = [];
    thread.turnStartedAt = Math.floor(Date.now() / 1000);
    this.write(thread, {
      type: "user",
      message: { role: "user", content: userContent(text, attachments) },
    });
    await this.store.record({ id: threadId, workspace: thread.workspace, model, preview: text });
    return turnId;
  }

  interruptTurn(threadId: string, turnId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (thread?.turnId === turnId) {
      // The CLI has no interrupt frame on this surface; stopping the process ends the Turn.
      this.stop(thread);
      thread.turnId = undefined;
      thread.turnItems = [];
      thread.pendingTools.clear();
    }
    return Promise.resolve();
  }

  /**
   * No-op: this Transport surfaces no approval requests, because a headless `claude` decides tool use
   * from `--permission-mode` alone and offers no channel to ask. See ADR-0005.
   */
  answerRequest(): void {}

  restart(): Promise<void> {
    for (const thread of this.threads.values()) this.stop(thread);
    this.emit("ready");
    return Promise.resolve();
  }

  close(): void {
    this.closing = true;
    for (const thread of this.threads.values()) this.stop(thread);
  }

  listThreads: ThreadStore["listThreads"] = (options) => this.store.listThreads(options);
  resumeThread: ThreadStore["resumeThread"] = (threadId) => this.store.resumeThread(threadId);
  renameThread: ThreadStore["renameThread"] = (threadId, name) => this.store.renameThread(threadId, name);
  pinThread: ThreadStore["pinThread"] = (threadId, pinned) => this.store.pinThread(threadId, pinned);
  archiveThread: ThreadStore["archiveThread"] = (threadId) => this.store.archiveThread(threadId);
  restoreThread: ThreadStore["restoreThread"] = (threadId) => this.store.restoreThread(threadId);
  forkThread: ThreadStore["forkThread"] = () => this.store.forkThread();

  async deleteThread(threadId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (thread) this.stop(thread);
    this.threads.delete(threadId);
    await this.store.deleteThread(threadId);
  }

  private async threadProcess(threadId: string): Promise<ThreadProcess> {
    const existing = this.threads.get(threadId);
    if (existing) return existing;
    const stored = await this.store.get(threadId);
    if (!stored) throw new Error(`Unknown Chat: ${threadId}`);
    const thread: ThreadProcess = {
      threadId,
      workspace: stored.workspace,
      model: stored.model,
      effort: "medium",
      // A Thread read back from the index was started by an earlier run, so the CLI already holds it.
      persisted: true,
      turnItems: [],
      pendingTools: new Map(),
    };
    this.threads.set(threadId, thread);
    return thread;
  }

  private ensureProcess(thread: ThreadProcess): void {
    if (thread.process && thread.process.exitCode === null) return;
    const { command, args } = claudeLaunch({
      claudePath: this.claudePath,
      permissionMode: this.permissionMode,
      model: thread.model,
      effort: thread.effort,
      threadId: thread.threadId,
      resume: thread.persisted,
    });
    const child = spawn(command, args, { cwd: thread.workspace, stdio: ["pipe", "pipe", "pipe"] });
    thread.process = child;
    child.stderr.on("data", (chunk) => this.emit("diagnostic", chunk.toString()));
    createInterface({ input: child.stdout }).on("line", (line) => {
      // Only a process that actually spoke has a session to resume; a spawn that fails must be able
      // to retry with `--session-id` rather than resuming a session the CLI never created.
      thread.persisted = true;
      this.receive(thread, line);
    });
    child.once("error", (error) => this.handleExit(thread, error));
    child.once("exit", () => this.handleExit(thread));
  }

  private receive(thread: ThreadProcess, line: string): void {
    let events;
    try {
      events = decodeClaudeEvents(JSON.parse(line));
    } catch {
      this.emit("diagnostic", "The Provider sent a malformed protocol message.");
      return;
    }
    for (const event of events) {
      if (!thread.turnId) return;
      const context = { threadId: thread.threadId, turnId: thread.turnId };
      switch (event.kind) {
        case "text":
          this.notify("item/agentMessage/delta", { ...context, itemId: event.itemId, delta: event.text });
          thread.turnItems.push({
            type: "agentMessage",
            id: event.itemId,
            text: event.text,
            phase: null,
            memoryCitation: null,
          });
          break;
        case "reasoning":
          this.notify("item/reasoning/summaryTextDelta", {
            ...context,
            itemId: event.itemId,
            delta: event.text,
            summaryIndex: 0,
          });
          break;
        case "toolStarted":
          thread.pendingTools.set(event.call.id, event.call);
          this.notify("item/started", {
            ...context,
            item: claudeToolItem(event.call),
            startedAtMs: Date.now(),
          });
          break;
        case "toolResult": {
          const call = thread.pendingTools.get(event.id);
          if (!call) break;
          thread.pendingTools.delete(event.id);
          const item = claudeToolItem(call, event.success ? "completed" : "failed", event.output);
          thread.turnItems.push(item);
          this.notify("item/completed", { ...context, item, completedAtMs: Date.now() });
          break;
        }
        case "userMessage":
          break;
        case "result":
          if (event.error)
            this.notify("error", {
              ...context,
              willRetry: false,
              error: { message: event.error, codexErrorInfo: null, additionalDetails: null },
            });
          this.completeTurn(thread, event.error ? "failed" : "completed");
          break;
      }
    }
  }

  private completeTurn(thread: ThreadProcess, status: Turn["status"]): void {
    const turnId = thread.turnId;
    if (!turnId) return;
    const startedAt = thread.turnStartedAt ?? Math.floor(Date.now() / 1000);
    const completedAt = Math.floor(Date.now() / 1000);
    thread.turnId = undefined;
    this.notify("turn/completed", {
      threadId: thread.threadId,
      turn: {
        id: turnId,
        items: thread.turnItems,
        itemsView: "full",
        status,
        error: null,
        startedAt,
        completedAt,
        durationMs: (completedAt - startedAt) * 1000,
      } satisfies Turn,
    });
    thread.turnItems = [];
    thread.pendingTools.clear();
  }

  private handleExit(thread: ThreadProcess, error?: Error): void {
    thread.process = undefined;
    if (this.closing) return;
    if (error) this.emit("diagnostic", error.message);
    if (!thread.turnId) return;
    // A process that dies mid-Turn is this Thread's failure, not a Provider-wide outage: every other
    // Thread has its own process, so `processExit` (which fails every active Turn) would overreach.
    this.notify("error", {
      threadId: thread.threadId,
      turnId: thread.turnId,
      willRetry: false,
      error: {
        message: "The Claude process stopped before the Turn finished.",
        codexErrorInfo: null,
        additionalDetails: null,
      },
    });
    this.completeTurn(thread, "failed");
  }

  private stop(thread: ThreadProcess): void {
    const child = thread.process;
    thread.process = undefined;
    if (!child || child.exitCode !== null) return;
    child.removeAllListeners("exit");
    child.removeAllListeners("error");
    child.kill();
  }

  private write(thread: ThreadProcess, message: unknown): void {
    if (!thread.process?.stdin.writable) throw new Error("Provider process is unavailable.");
    thread.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.emit("notification", { method, params } as unknown as ServerNotificationEnvelope);
  }

  /**
   * Best-effort transcript recovery from the Provider's own rollout file. The format is undocumented,
   * so any failure yields an empty transcript rather than an error: History still lists the Chat and
   * the next Turn still resumes it.
   */
  private async readTranscript(thread: StoredThread): Promise<Turn[]> {
    const path = await this.findRollout(thread.id);
    if (!path) return [];
    try {
      const turns: Turn[] = [];
      for (const line of (await readFile(path, "utf8")).split("\n")) {
        if (!line.trim()) continue;
        for (const event of decodeClaudeEvents(JSON.parse(line) as unknown)) {
          if (event.kind === "text")
            turns.push(
              transcriptTurn(event.itemId, {
                type: "agentMessage",
                id: event.itemId,
                text: event.text,
                phase: null,
                memoryCitation: null,
              }),
            );
          else if (event.kind === "userMessage")
            turns.push(
              transcriptTurn(event.itemId, {
                type: "userMessage",
                id: event.itemId,
                clientId: null,
                content: [{ type: "text", text: event.text, text_elements: [] }],
              }),
            );
        }
      }
      return turns;
    } catch {
      return [];
    }
  }

  private async findRollout(threadId: string): Promise<string | undefined> {
    try {
      for (const entry of await readdir(this.rolloutRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const directory = join(this.rolloutRoot, entry.name);
        const files = await readdir(directory).catch((): string[] => []);
        if (files.includes(`${threadId}.jsonl`)) return join(directory, `${threadId}.jsonl`);
      }
    } catch {
      // No rollout directory means no recoverable transcript.
    }
    return undefined;
  }
}

function transcriptTurn(id: string, item: ThreadItem): Turn {
  return {
    id,
    items: [item],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

function userContent(text: string, attachments: TurnAttachment[]): unknown[] {
  const content: unknown[] = [{ type: "text", text }];
  for (const attachment of attachments) {
    if (attachment.kind === "text") {
      content.push({
        type: "text",
        text: `\n\n<attached-file name="${attachment.name}">\n${attachment.text}\n</attached-file>`,
      });
      continue;
    }
    const data = attachment.dataUrl.slice(attachment.dataUrl.indexOf(",") + 1);
    content.push({
      type: "image",
      source: { type: "base64", media_type: attachment.mimeType, data },
    });
  }
  return content;
}

export function claudeLaunch(
  options: {
    claudePath: string;
    permissionMode: ClaudePermissionMode;
    model: string;
    effort: ReasoningEffort;
    threadId: string;
    resume: boolean;
  },
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): { command: string; args: string[] } {
  const args = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    options.permissionMode,
    "--model",
    options.model,
    "--effort",
    // Norvyn's lowest Reasoning Effort has no Claude equivalent; `low` is the nearest supported level.
    options.effort === "minimal" ? "low" : options.effort,
    options.resume ? "--resume" : "--session-id",
    options.threadId,
  ];
  if (environment.NORVYN_CLAUDE_COMMAND) {
    const configured = environment.NORVYN_CLAUDE_ARGUMENTS
      ? (JSON.parse(environment.NORVYN_CLAUDE_ARGUMENTS) as string[])
      : [];
    return { command: environment.NORVYN_CLAUDE_COMMAND, args: [...configured, ...args] };
  }
  if (platform === "win32") {
    const quoted = safeExecutablePath(options.claudePath);
    return {
      command: environment.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", `${quoted} ${args.join(" ")}`],
    };
  }
  return { command: options.claudePath, args };
}
