import { readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import type { ServerRequest } from "../schemas/ServerRequest.js";
import { discardDraft, isNorvynDraftKey, loadDraft, saveDraft } from "../src/client/drafts.js";
import { highlight, MarkdownContent, safeUrl } from "../src/client/markdown.js";
import { reconnectDelay, visibleTranscript } from "../src/client/windowing.js";
import { createDiagnostics, sanitize, sanitizedDiagnosticExport } from "../src/features/diagnostics.js";
import { ApprovalFeature } from "../src/features/approvals.js";
import { ChatRegistry } from "../src/features/chats.js";
import { mergeHistoryPages } from "../src/features/history.js";
import { checkForUpdate, isNewer, performConfirmedUpdate, updateCommand } from "../src/features/update.js";
import { PlatformWorkspacePicker } from "../src/features/workspace-picker.js";
import { parseBrowserCommand } from "../src/protocol.js";
import { DEFAULT_SETTINGS, loadUserSettings, saveUserSettings } from "../src/settings.js";
import { NORVYN_VERSION } from "../src/version.js";

const temporaryPaths: string[] = [];
afterEach(async () =>
  Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

test("legacy model configuration migrates into validated User Settings", async () => {
  const path = temporaryFile("legacy-settings.json");
  await writeFile(
    path,
    JSON.stringify({ models: ["gpt-5.6-terra"], defaultModel: "gpt-5.6-terra", versionChecks: false }),
  );
  const result = await loadUserSettings(path);
  expect(result.migrated).toBe(true);
  expect(result.settings).toMatchObject({
    version: 1,
    customModels: ["gpt-5.6-terra"],
    defaultModel: "gpt-5.6-terra",
  });
});

test("partial and corrupted settings recover safely without corrupting the last valid file", async () => {
  const path = temporaryFile("settings.json");
  await writeFile(path, JSON.stringify({ version: 1, customModels: [], textScale: "large" }));
  expect((await loadUserSettings(path)).settings).toMatchObject({
    textScale: "large",
    transcriptDensity: "comfortable",
  });

  const valid = await saveUserSettings({ ...DEFAULT_SETTINGS, textScale: "small" }, path);
  await expect(saveUserSettings({ ...valid, textScale: "impossible" } as never, path)).rejects.toThrow(
    "textScale",
  );
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ textScale: "small" });

  await writeFile(path, "{broken");
  const recovered = await loadUserSettings(path);
  expect(recovered.settings).toEqual(DEFAULT_SETTINGS);
  expect(recovered.warning).toContain("defaults are being used");
});

test("User Settings persist only the approved local preference fields", async () => {
  const path = temporaryFile("whitelist.json");
  await saveUserSettings(
    { ...DEFAULT_SETTINGS, workspace: "secret", accessMode: "auto", credential: "secret" } as never,
    path,
  );
  const persisted = JSON.parse(await readFile(path, "utf8"));
  expect(Object.keys(persisted).sort()).toEqual([
    "customModels",
    "textScale",
    "transcriptDensity",
    "version",
    "versionChecks",
  ]);
  expect(JSON.stringify(persisted)).not.toContain("secret");
});

test("draft storage is isolated per Chat and contains neither credentials nor transcripts", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  saveDraft(storage, "chat-a", "unfinished A");
  saveDraft(storage, "chat-b", "unfinished B");
  expect(loadDraft(storage, "chat-a")).toBe("unfinished A");
  expect(loadDraft(storage, "chat-b")).toBe("unfinished B");
  expect([...values.keys()].every(isNorvynDraftKey)).toBe(true);
  discardDraft(storage, "chat-a");
  expect(loadDraft(storage, "chat-a")).toBe("");
});

test("large transcript rendering and reconnection delays remain bounded", () => {
  const transcript = Array.from({ length: 10_000 }, (_, index) => index);
  expect(visibleTranscript(transcript)).toHaveLength(200);
  expect(visibleTranscript(transcript)[0]).toBe(9_800);
  expect(reconnectDelay(0, () => 0)).toBe(200);
  expect(reconnectDelay(100, () => 1)).toBeLessThanOrEqual(12_000);
});

test("incremental History merges without refetch duplicates and keeps pinned Chats first", () => {
  const thread = (id: string, pinned = false, updatedAt = 1) => ({
    id,
    title: id,
    preview: id,
    workspace: "w",
    updatedAt,
    createdAt: 1,
    pinned,
    archived: false,
  });
  const first = mergeHistoryPages([], [thread("a", false, 3), thread("b", false, 2)], true);
  const second = mergeHistoryPages(first, [thread("b", true, 2), thread("c", false, 1)], false);
  expect(second.map((item) => item.id)).toEqual(["b", "a", "c"]);
});

test("unsupported browser protocol variants fail explicitly", () => {
  expect(() => parseBrowserCommand({ type: "history/drop-everything" })).toThrow("unsupported operation");
  expect(() => parseBrowserCommand("turn/start")).toThrow("must be an object");
  expect(() => parseBrowserCommand({ type: "turn/start", text: 42 })).toThrow("Invalid text");
  expect(() =>
    parseBrowserCommand({ type: "chat/access-mode", chatId: "one", accessMode: "unsafe" }),
  ).toThrow("Invalid accessMode");
});

test("diagnostic export removes credentials recursively and gives unhealthy states a next action", () => {
  const report = createDiagnostics({
    norvynVersion: "1.0.0",
    codexPath: "codex",
    localSession: "expired",
    providerProcess: "failed",
    connection: "disconnected",
  });
  expect(report.nextAction).toBe("Connect With Codex again.");
  const exported = sanitizedDiagnosticExport(report, {
    launchToken: "secret",
    nested: { apiKey: "secret", safe: "yes" },
  });
  expect(exported).not.toContain("secret");
  expect(exported).toContain("yes");
  expect(sanitize({ password: "no", value: "ok" })).toEqual({ value: "ok" });
});

test("version checks request only public package metadata and tolerate disabled or offline checks", async () => {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => ({
    ok: Boolean(url && init),
    json: async () => ({ version: "0.2.0" }),
  }));
  expect(await checkForUpdate("0.1.0", true, fetcher)).toEqual({ installed: "0.1.0", available: "0.2.0" });
  expect(fetcher).toHaveBeenCalledWith("https://registry.npmjs.org/norvyn/latest", {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
  });
  expect(await checkForUpdate("0.1.0", false, fetcher)).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    await checkForUpdate("0.1.0", true, async () => {
      throw new Error("offline");
    }),
  ).toBeUndefined();
  expect(isNewer("1.0.0", "0.9.9")).toBe(true);
});

test("global update requires confirmation and streams through the injected installer seam", async () => {
  const lines: string[] = [];
  const install = vi.fn(async (_version: string, progress: (line: string) => void) => {
    progress("downloading");
    progress("installed");
  });
  await expect(performConfirmedUpdate("1.2.3", false, { install }, () => undefined)).rejects.toThrow(
    "explicit confirmation",
  );
  await performConfirmedUpdate("1.2.3", true, { install }, (line) => lines.push(line));
  expect(install).toHaveBeenCalledTimes(1);
  expect(lines).toEqual(["downloading", "installed"]);
  expect(updateCommand("1.2.3")).toBe("npm install -g norvyn@1.2.3");
  expect(() => updateCommand("latest && bad")).toThrow("Invalid package version");
});

test("Workspace picker adapter reports selection, cancellation, failure, and unsupported platforms", async () => {
  const selected = new PlatformWorkspacePicker("win32", async (_command, _args, options) => {
    expect(options).toEqual({ windowsHide: true, timeout: 120_000 });
    return "C:\\Workspaces\\alpha\n";
  });
  await expect(selected.select()).resolves.toEqual({
    status: "selected",
    workspace: "C:\\Workspaces\\alpha",
  });

  await expect(new PlatformWorkspacePicker("win32", async () => "").select()).resolves.toEqual({
    status: "cancelled",
  });
  await expect(
    new PlatformWorkspacePicker("win32", async () => {
      throw new Error("powershell.exe -secret launch details");
    }).select(),
  ).resolves.toMatchObject({ status: "failed", message: expect.not.stringContaining("powershell") });
  await expect(new PlatformWorkspacePicker("linux", vi.fn()).select()).resolves.toMatchObject({
    status: "unavailable",
  });
});

test("Chat and approval feature seams are independently testable", () => {
  const chats = new ChatRegistry();
  const chat = chats.create("C:\\workspace", "verified-model");
  expect(chats.public(chat)).not.toHaveProperty("turns");
  chat.threadId = "thread-one";
  expect(chats.findByThread("thread-one")).toBe(chat);

  const emit = vi.fn();
  const answerRequest = vi.fn();
  const approvals = new ApprovalFeature(10_000, emit);
  const request = {
    method: "item/fileChange/requestApproval",
    id: 7,
    params: {
      threadId: "thread-one",
      turnId: "turn-one",
      itemId: "item-one",
      reason: "edit requested",
      grantRoot: null,
    },
  } as ServerRequest;
  approvals.handle(request, { answerRequest }, chat);
  expect(emit).toHaveBeenCalledWith(
    expect.objectContaining({ type: "approval/request", requestId: 7, kind: "file-change" }),
  );
  approvals.respond(7, false, { answerRequest });
  expect(answerRequest).toHaveBeenCalledWith(7, { decision: "decline" });

  chat.accessMode = "auto-edit";
  approvals.handle({ ...request, id: 8 } as ServerRequest, { answerRequest }, chat);
  expect(answerRequest).toHaveBeenCalledWith(8, { decision: "accept" });
  approvals.close();
});

test("Markdown renders GFM safely while preserving code and diff text", () => {
  const markdown =
    "# Heading\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n> quote\n\n[good](https://example.com) [bad](javascript:alert(1))\n\n<script>alert(1)</script>\n\n```diff\n+added\n-removed\n```";
  const html = renderToStaticMarkup(<MarkdownContent text={markdown} complete />);
  expect(html).toContain("<h1>Heading</h1>");
  expect(html).toContain("<table>");
  expect(html).toContain('href="https://example.com"');
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain("<script>");
  expect(html).toContain("language-diff");
  expect(html).toContain("+added");
  expect(html).toContain("-removed");
  expect(html).toContain("Copy message");
  expect(safeUrl("data:text/html,bad")).toBe("");
  expect(highlight("<script>", "unknown")).not.toContain("<script>");
});

test("release metadata and public documentation agree on the package version and local contract", async () => {
  const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  const site = await readFile(join(process.cwd(), "site", "index.html"), "utf8");
  expect(packageJson.version).toBe(NORVYN_VERSION);
  expect(packageJson.name).toBe("norvyn");
  expect(site).toContain("npm install -g norvyn");
  expect(site).toContain("Node.js 22+");
  expect(site).toContain("no analytics or telemetry");
  expect(site).not.toMatch(/google-analytics|segment|posthog/i);
});

function temporaryFile(name: string): string {
  const directory = join(tmpdir(), `norvyn-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(directory, { recursive: true });
  temporaryPaths.push(directory);
  return join(directory, name);
}
