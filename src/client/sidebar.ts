import type { ThreadSummary } from "../protocol.js";

export interface DropdownOption {
  value: string;
  label: string;
  detail?: string;
  tone?: string;
}

export function filterThreads<T extends Pick<ThreadSummary, "title" | "preview">>(
  threads: T[],
  search: string,
): T[] {
  const query = search.trim().toLocaleLowerCase();
  return query
    ? threads.filter(
        (thread) =>
          thread.title.toLocaleLowerCase().includes(query) ||
          thread.preview.toLocaleLowerCase().includes(query),
      )
    : threads;
}

export function groupThreadsByWorkspace<T extends Pick<ThreadSummary, "workspace">>(
  threads: T[],
): { workspace: string; threads: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const thread of threads) {
    const workspace = thread.workspace || "Unknown Workspace";
    const group = groups.get(workspace);
    if (group) group.push(thread);
    else groups.set(workspace, [thread]);
  }
  return [...groups].map(([workspace, grouped]) => ({ workspace, threads: grouped }));
}

export function workspaceName(workspace: string): string {
  return (
    workspace
      .split(/[\\/]+/)
      .filter(Boolean)
      .at(-1) ?? workspace
  );
}

export function visibleGroupThreads<T>(threads: T[], expanded: boolean): T[] {
  return expanded ? threads : threads.slice(0, 5);
}

export function visibleWorkspaces(workspaces: string[]): string[] {
  return workspaces.slice(0, 5);
}

export function modelOption(model: string, verified = true): DropdownOption {
  if (!verified) return { value: model, label: model, detail: "Unverified custom model", tone: "unverified" };
  if (model === "gpt-5.6" || model === "gpt-5.6-sol")
    return { value: model, label: "GPT-5.6 Sol", detail: "Frontier", tone: "sol" };
  if (model === "gpt-5.6-terra")
    return { value: model, label: "GPT-5.6 Terra", detail: "Balanced", tone: "terra" };
  if (model === "gpt-5.6-luna")
    return { value: model, label: "GPT-5.6 Luna", detail: "Efficient", tone: "luna" };
  return { value: model, label: model, detail: "Codex" };
}

export function formatThreadTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(timestamp * 1000),
  );
}
