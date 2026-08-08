import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Thread } from "../schemas/v2/Thread.js";
import type { ThreadForkResponse } from "../schemas/v2/ThreadForkResponse.js";
import type { ThreadResumeResponse } from "../schemas/v2/ThreadResumeResponse.js";
import type { Turn } from "../schemas/v2/Turn.js";
import type { ProviderKind, ThreadCapabilities } from "./protocol.js";
import type { ThreadListOptions, ThreadPage, ThreadStore } from "./transport.js";

/**
 * One Thread as Norvyn knows it. Deliberately holds no Turns: transcripts stay in the Provider's own
 * rollout files and are read back through its resume path, so there is one record of any conversation.
 */
export interface StoredThread {
  id: string;
  workspace: string;
  model: string;
  name?: string;
  preview: string;
  pinned: boolean;
  archived: boolean;
  /** Unix seconds, matching the Provider-owned Thread shape this store is read back through. */
  createdAt: number;
  updatedAt: number;
}

export interface ThreadStoreOptions {
  /** Recorded on every Thread this store owns. */
  modelProvider: ProviderKind;
  /** Index location. Defaults to `~/.norvyn/threads.json`, or `$NORVYN_THREAD_INDEX`. */
  path?: string;
  now?(): number;
  cliVersion?: string;
  /** Reads a Thread's transcript back from the Provider. Absent means resume yields no Turns. */
  readTranscript?(thread: StoredThread): Promise<Turn[]>;
}

const capabilities: ThreadCapabilities = {
  rename: true,
  pin: true,
  archive: true,
  restore: true,
  delete: true,
  // No Provider operation can fork a Thread at a chosen Turn, so branching is declined, not simulated.
  branch: false,
};

export function threadIndexPath(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.NORVYN_THREAD_INDEX ?? join(homedir(), ".norvyn", "threads.json");
}

/**
 * History for a Provider that persists transcripts but exposes no way to list, name, or organise them.
 * Norvyn owns the index — identifiers it assigned, Workspace, name, pinned and archived state — and
 * nothing else; see ADR-0005.
 */
export class NorvynThreadStore implements ThreadStore {
  readonly capabilities = capabilities;
  private readonly path: string;
  private readonly now: () => number;
  private readonly cliVersion: string;
  private readonly modelProvider: ProviderKind;
  private readonly readTranscript?: (thread: StoredThread) => Promise<Turn[]>;
  private threads?: Map<string, StoredThread>;
  private writing: Promise<void> = Promise.resolve();

  constructor(options: ThreadStoreOptions) {
    this.path = options.path ?? threadIndexPath();
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.cliVersion = options.cliVersion ?? "unknown";
    this.modelProvider = options.modelProvider;
    this.readTranscript = options.readTranscript;
  }

  /** Records a Thread the Transport has just started, or refreshes one it has just used. */
  async record(thread: Omit<StoredThread, "createdAt" | "updatedAt" | "pinned" | "archived">): Promise<void> {
    const threads = await this.load();
    const existing = threads.get(thread.id);
    const timestamp = this.now();
    threads.set(thread.id, {
      ...existing,
      ...thread,
      // A user-chosen name and the first user message both survive later Turns on the same Thread.
      name: thread.name ?? existing?.name,
      preview: existing?.preview || thread.preview,
      pinned: existing?.pinned ?? false,
      archived: existing?.archived ?? false,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    await this.persist();
  }

  async listThreads(options: ThreadListOptions = {}): Promise<ThreadPage> {
    const threads = await this.load();
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const offset = decodeCursor(options.cursor);
    const search = options.search?.trim().toLowerCase();
    const matching = [...threads.values()]
      .filter((thread) => thread.archived === (options.archived ?? false))
      .filter((thread) => !search || `${thread.name ?? ""} ${thread.preview}`.toLowerCase().includes(search))
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt);
    const page = matching.slice(offset, offset + limit);
    return {
      threads: page.map((thread) => this.toThread(thread)),
      nextCursor: offset + page.length < matching.length ? String(offset + page.length) : undefined,
    };
  }

  async resumeThread(threadId: string): Promise<ThreadResumeResponse> {
    const thread = await this.require(threadId);
    const turns = (await this.readTranscript?.(thread)) ?? [];
    return {
      thread: { ...this.toThread(thread), turns },
      model: thread.model,
      modelProvider: this.modelProvider,
      serviceTier: null,
      cwd: thread.workspace,
      instructionSources: [],
      // Reported as it actually is, not as CONTEXT.md's Boundary would like it: a Provider reached
      // through a CLI that cannot be told to block network access, and that never asks for approval.
      // See ADR-0005 and the follow-up tracking the gap.
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: {
        type: "workspaceWrite",
        writableRoots: [thread.workspace],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      reasoningEffort: null,
    };
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    await this.update(threadId, (thread) => ({ ...thread, name }));
  }

  async pinThread(threadId: string, pinned: boolean): Promise<void> {
    await this.update(threadId, (thread) => ({ ...thread, pinned }));
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.update(threadId, (thread) => ({ ...thread, archived: true }));
  }

  async restoreThread(threadId: string): Promise<void> {
    await this.update(threadId, (thread) => ({ ...thread, archived: false }));
  }

  /**
   * Forgets the Thread. The Provider's own rollout file is left untouched, so the transcript remains
   * visible from the Provider's tooling even though Norvyn's History no longer lists it.
   */
  async deleteThread(threadId: string): Promise<void> {
    const threads = await this.load();
    if (!threads.delete(threadId)) throw new Error(`Unknown Chat: ${threadId}`);
    await this.persist();
  }

  forkThread(): Promise<ThreadForkResponse> {
    return Promise.reject(new Error("This Provider does not support Chat branching."));
  }

  async get(threadId: string): Promise<StoredThread | undefined> {
    return (await this.load()).get(threadId);
  }

  private async require(threadId: string): Promise<StoredThread> {
    const thread = (await this.load()).get(threadId);
    if (!thread) throw new Error(`Unknown Chat: ${threadId}`);
    return thread;
  }

  private async update(threadId: string, change: (thread: StoredThread) => StoredThread): Promise<void> {
    const threads = await this.load();
    const thread = await this.require(threadId);
    threads.set(threadId, { ...change(thread), updatedAt: this.now() });
    await this.persist();
  }

  private async load(): Promise<Map<string, StoredThread>> {
    if (this.threads) return this.threads;
    this.threads = new Map();
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      for (const entry of Array.isArray(parsed) ? parsed : []) {
        const thread = normalizeStoredThread(entry);
        if (thread) this.threads.set(thread.id, thread);
      }
    } catch {
      // A missing or unreadable index means no History yet; it is rebuilt as Threads are started.
    }
    return this.threads;
  }

  /** Serialises writes so concurrent History mutations cannot interleave two full-file rewrites. */
  private persist(): Promise<void> {
    const threads = [...(this.threads?.values() ?? [])];
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(threads, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.path);
    });
    return this.writing;
  }

  private toThread(thread: StoredThread): Thread {
    return {
      id: thread.id,
      sessionId: thread.id,
      forkedFromId: null,
      parentThreadId: null,
      preview: thread.preview,
      ephemeral: false,
      isPinned: thread.pinned,
      modelProvider: this.modelProvider,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      recencyAt: thread.updatedAt,
      status: { type: "idle" },
      path: null,
      cwd: thread.workspace,
      cliVersion: this.cliVersion,
      source: "appServer",
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: thread.name ?? null,
      turns: [],
    };
  }
}

function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0) throw new Error("History cursor is invalid or stale.");
  return offset;
}

function normalizeStoredThread(input: unknown): StoredThread | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (typeof value.id !== "string" || !value.id.trim()) return undefined;
  if (typeof value.workspace !== "string" || !value.workspace.trim()) return undefined;
  return {
    id: value.id,
    workspace: value.workspace,
    model: typeof value.model === "string" ? value.model : "",
    name: typeof value.name === "string" && value.name.trim() ? value.name : undefined,
    preview: typeof value.preview === "string" ? value.preview : "",
    pinned: value.pinned === true,
    archived: value.archived === true,
    createdAt: finite(value.createdAt),
    updatedAt: finite(value.updatedAt),
  };
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
