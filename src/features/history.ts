import type { Thread } from "../../schemas/v2/Thread.js";
import type { ThreadSummary } from "../protocol.js";
import type { ThreadListOptions, ThreadPage, ThreadStore } from "../transport.js";

export const HISTORY_PAGE_SIZE = 50;

export function summarizeThread(thread: Thread, archived = false): ThreadSummary {
  return {
    id: thread.id,
    title: thread.name || thread.preview || "Untitled Chat",
    preview: thread.preview,
    workspace: String(thread.cwd),
    updatedAt: thread.recencyAt ?? thread.updatedAt,
    createdAt: thread.createdAt,
    pinned: thread.isPinned,
    archived,
  };
}

export function mergeHistoryPages(
  current: ThreadSummary[],
  page: ThreadSummary[],
  reset: boolean,
): ThreadSummary[] {
  const source = reset ? [] : current;
  const byId = new Map(source.map((thread) => [thread.id, thread]));
  for (const thread of page) byId.set(thread.id, thread);
  return [...byId.values()].sort(
    (left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt,
  );
}

export async function collectAllThreads(
  store: ThreadStore,
  options: Omit<ThreadListOptions, "cursor" | "limit"> = {},
): Promise<Thread[]> {
  const result: Thread[] = [];
  let cursor: string | undefined;
  do {
    const page: ThreadPage = await store.listThreads({ ...options, cursor, limit: 100 });
    result.push(...page.threads);
    cursor = page.nextCursor;
  } while (cursor);
  return result;
}
