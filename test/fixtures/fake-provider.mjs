import { existsSync, readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

if (process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.146.1\n");
  process.exit(0);
}

if (process.argv[2] === "login" && process.argv[3] === "status") {
  if (
    process.env.NORVYN_FAKE_SIGNED_OUT === "1" &&
    (!process.env.NORVYN_FAKE_LOGIN_MARKER || !existsSync(process.env.NORVYN_FAKE_LOGIN_MARKER))
  )
    process.exit(1);
  process.stderr.write("Logged in using ChatGPT\n");
  process.exit(0);
}

if (process.argv[2] === "login") {
  if (process.env.NORVYN_FAKE_LOGIN_MODE === "fails") process.exit(1);
  if (process.env.NORVYN_FAKE_LOGIN_MARKER) writeFileSync(process.env.NORVYN_FAKE_LOGIN_MARKER, "connected");
  process.exit(0);
}

const marker = process.env.NORVYN_FAKE_MARKER;
const failAfterCrash = process.env.NORVYN_FAKE_MODE === "restart-fails";
let initialized = false;
let threadCount = 0;
let lastThreadStart;
let pendingApproval;

if (failAfterCrash && marker && existsSync(marker)) process.exit(1);

let seededThreads = [
  thread("history-new", "Newest architecture chat", "C:\\workspaces\\alpha", 200),
  thread("history-old", "Older testing chat", "C:\\workspaces\\beta", 100),
];
let archivedThreads = [thread("history-archived", "Archived planning chat", "C:\\workspaces\\alpha", 50)];
const requestedHistoryCount = Number(process.env.NORVYN_FAKE_HISTORY_COUNT ?? 0);
if (requestedHistoryCount > seededThreads.length) {
  seededThreads = Array.from({ length: requestedHistoryCount }, (_, index) =>
    thread(
      `history-${index}`,
      index === 0
        ? "A very long architecture discussion title that must remain operable without clipping actions"
        : index === 1
          ? "Only-one-cardinality-marker"
          : index >= 40 && index < 45
            ? `Five-workspace-cardinality-marker ${index}`
            : index >= 50 && index < 56
              ? `Six-workspace-cardinality-marker ${index}`
              : `Synthetic Chat ${index}`,
      index === 0
        ? "C:\\workspaces\\a-very-long-workspace-name\\nested\\deeper\\norvyn-agent"
        : `C:\\workspaces\\${index % 7}`,
      requestedHistoryCount - index,
    ),
  );
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {});
    return;
  }
  if (message.method === "initialized") {
    initialized = true;
    return;
  }
  if (!message.method && message.id !== undefined && pendingApproval?.id === message.id) {
    const current = pendingApproval;
    pendingApproval = undefined;
    current.resolve(message.result?.decision ?? "unknown");
    return;
  }
  if (!initialized) throw new Error(`${message.method} before initialized`);
  if (message.method === "model/list") {
    if (process.env.NORVYN_FAKE_MODEL_MODE === "fails") {
      reject(message.id, { message: "raw model discovery failure secret" });
      return;
    }
    if (process.env.NORVYN_FAKE_MODEL_MODE === "empty") {
      reply(message.id, { data: [], nextCursor: null });
      return;
    }
    const configuredModels = process.env.NORVYN_FAKE_MODEL_FILE
      ? JSON.parse(readFileSync(process.env.NORVYN_FAKE_MODEL_FILE, "utf8"))
      : undefined;
    reply(message.id, {
      data: configuredModels
        ? configuredModels.map((id, index) => model(id, id, index === 0))
        : [
            model("gpt-5.6-sol", "GPT-5.6 Sol", true),
            model("gpt-5.6-terra", "GPT-5.6 Terra"),
            model("gpt-5.6-luna", "GPT-5.6 Luna"),
            { ...model("hidden-model", "Hidden model"), hidden: true },
          ],
      nextCursor: null,
    });
    return;
  }
  if (message.method === "thread/list") {
    const query = message.params.searchTerm?.toLowerCase();
    const source = message.params.archived ? archivedThreads : seededThreads;
    const filtered = source
      .filter((item) => message.params.isPinned == null || item.isPinned === message.params.isPinned)
      .filter((item) => !query || (item.name || item.preview).toLowerCase().includes(query));
    const offset = Number(message.params.cursor ?? 0);
    const limit = Number(message.params.limit ?? 100);
    const data = filtered.slice(offset, offset + limit);
    const nextCursor = offset + data.length < filtered.length ? String(offset + data.length) : null;
    reply(message.id, { data, nextCursor, backwardsCursor: null });
    return;
  }
  if (message.method === "thread/name/set") {
    const found = [...seededThreads, ...archivedThreads].find((item) => item.id === message.params.threadId);
    if (found) found.name = message.params.name;
    reply(message.id, {});
    notify("thread/name/updated", { threadId: message.params.threadId, name: message.params.name });
    return;
  }
  if (message.method === "thread/metadata/update") {
    const found = [...seededThreads, ...archivedThreads].find((item) => item.id === message.params.threadId);
    if (found && typeof message.params.isPinned === "boolean") found.isPinned = message.params.isPinned;
    reply(message.id, {});
    return;
  }
  if (message.method === "thread/archive") {
    const found = seededThreads.find((item) => item.id === message.params.threadId);
    seededThreads = seededThreads.filter((item) => item.id !== message.params.threadId);
    if (found) archivedThreads.unshift(found);
    reply(message.id, {});
    notify("thread/archived", { threadId: message.params.threadId });
    return;
  }
  if (message.method === "thread/unarchive") {
    const found = archivedThreads.find((item) => item.id === message.params.threadId);
    archivedThreads = archivedThreads.filter((item) => item.id !== message.params.threadId);
    if (found) seededThreads.unshift(found);
    reply(message.id, {});
    notify("thread/unarchived", { threadId: message.params.threadId });
    return;
  }
  if (message.method === "thread/delete") {
    seededThreads = seededThreads.filter((item) => item.id !== message.params.threadId);
    archivedThreads = archivedThreads.filter((item) => item.id !== message.params.threadId);
    reply(message.id, {});
    notify("thread/deleted", { threadId: message.params.threadId });
    return;
  }
  if (message.method === "thread/resume") {
    const found =
      [...seededThreads, ...archivedThreads].find((item) => item.id === message.params.threadId) ??
      thread(message.params.threadId, "Resumed Chat", "C:\\workspaces\\alpha", 200);
    if (process.env.NORVYN_FAKE_LONG_CHAT === "1")
      found.turns = Array.from({ length: 260 }, (_, index) => ({
        id: `long-turn-${index}`,
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: index * 2 + 1,
        completedAt: index * 2 + 2,
        durationMs: 1000,
        items: [
          {
            type: "userMessage",
            id: `long-user-${index}`,
            clientId: null,
            content: [
              {
                type: "text",
                text: `Long transcript question ${index}`,
                text_elements: [],
              },
            ],
          },
          {
            type: "agentMessage",
            id: `long-agent-${index}`,
            text: `Long transcript answer ${index}. This content verifies bounded rendering and scrolling.`,
            phase: null,
            memoryCitation: null,
          },
        ],
      }));
    else if (!found.turns.length)
      found.turns = [
        {
          id: "past-turn",
          itemsView: "full",
          status: "completed",
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1000,
          items: [
            {
              type: "userMessage",
              id: "past-user",
              clientId: null,
              content: [{ type: "text", text: "Previous question", text_elements: [] }],
            },
            {
              type: "agentMessage",
              id: "past-agent",
              text: "Previous answer",
              phase: null,
              memoryCitation: null,
            },
          ],
        },
      ];
    reply(message.id, {
      thread: found,
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      serviceTier: null,
      cwd: found.cwd,
      instructionSources: [],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: {
        type: "workspaceWrite",
        writableRoots: [found.cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      reasoningEffort: null,
    });
    return;
  }
  if (message.method === "thread/fork") {
    const source = [...seededThreads, ...archivedThreads].find((item) => item.id === message.params.threadId);
    if (!source) return reject(message.id, { message: "Unknown source thread" });
    const fork = thread(`fork-${++threadCount}`, `Branch of ${source.name}`, source.cwd, Date.now());
    fork.forkedFromId = source.id;
    const through = message.params.lastTurnId
      ? source.turns.findIndex((turn) => turn.id === message.params.lastTurnId)
      : source.turns.length - 1;
    fork.turns = through >= 0 ? structuredClone(source.turns.slice(0, through + 1)) : [];
    seededThreads.unshift(fork);
    reply(message.id, {
      thread: fork,
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      serviceTier: null,
      cwd: fork.cwd,
      instructionSources: [],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: {
        type: "workspaceWrite",
        writableRoots: [fork.cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      reasoningEffort: null,
    });
    return;
  }
  if (message.method === "thread/start") {
    lastThreadStart = message.params;
    threadCount += 1;
    const created = thread(`thread-${threadCount}`, "New Chat", message.params.cwd, Date.now());
    seededThreads.unshift(created);
    reply(message.id, { thread: { id: created.id } });
    return;
  }
  if (message.method === "turn/start") {
    const text = message.params.input[0].text;
    if (text === "malformed-provider-response") {
      process.stdout.write(`${JSON.stringify({ id: message.id, error: { message: 42 } })}\n`);
      return;
    }
    if (text === "invalid-json-provider-response") {
      process.stdout.write("{invalid-provider-json\n");
      return;
    }
    if (String(message.params.model).startsWith("custom-")) {
      reject(message.id, { message: "The custom model is not available. Choose a Provider-verified model." });
      return;
    }
    if (text === "request-json-error") {
      reject(message.id, {
        message:
          '{"status":400,"error":{"type":"invalid_request_error","message":"Provider rejected this request."}}',
      });
      return;
    }
    if (text === "request-malformed-json-error") {
      reject(message.id, { message: '{"status":500,"error":' });
      return;
    }
    const turnId = `turn-${message.params.threadId}-${Date.now()}`;
    reply(message.id, { turn: { id: turnId } });
    if (text === "crash") {
      if (failAfterCrash && marker) writeFileSync(marker, "crashed");
      setTimeout(() => process.exit(1), 5);
      return;
    }
    if (text === "slow") return;
    if (text === "external-rename") {
      const found = seededThreads.find((item) => item.id === message.params.threadId);
      if (found) found.name = "Provider renamed Chat";
      notify("thread/name/updated", { threadId: message.params.threadId, name: "Provider renamed Chat" });
      complete(turnId, message.params.threadId, "Renamed", text);
      return;
    }
    if (text === "Follow streamed output at the bottom") {
      const chunks = Array.from({ length: 12 }, (_, index) => `stream-${index} ${"x".repeat(160)} `);
      chunks.forEach((chunk, index) =>
        setTimeout(
          () => {
            notify("item/agentMessage/delta", {
              threadId: message.params.threadId,
              turnId,
              itemId: `agent-${turnId}`,
              delta: chunk,
            });
            if (index === chunks.length - 1)
              notify("turn/completed", {
                threadId: message.params.threadId,
                turn: completedTurn(turnId),
              });
          },
          10 * (index + 1),
        ),
      );
      return;
    }
    if (text === "unsupported-model") {
      notify("error", {
        threadId: message.params.threadId,
        turnId,
        willRetry: false,
        error: {
          message:
            '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.6\' model is not supported when using Codex with a ChatGPT account."}}',
          codexErrorInfo: "badRequest",
          additionalDetails: null,
        },
      });
      return;
    }
    if (text === "inspect-boundary")
      return complete(
        turnId,
        message.params.threadId,
        JSON.stringify({ thread: lastThreadStart, turn: message.params }),
      );
    if (text === "reasoning-tools") {
      notify("item/reasoning/summaryTextDelta", {
        threadId: message.params.threadId,
        turnId,
        itemId: "reason-1",
        delta: "Checked the Workspace.",
        summaryIndex: 0,
      });
      const started = {
        type: "commandExecution",
        id: "tool-1",
        pluginId: null,
        scriptPath: null,
        command: "npm test",
        cwd: lastThreadStart.cwd,
        processId: null,
        source: "agent",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      };
      notify("item/started", {
        threadId: message.params.threadId,
        turnId,
        item: started,
        startedAtMs: Date.now(),
      });
      notify("item/commandExecution/outputDelta", {
        threadId: message.params.threadId,
        turnId,
        itemId: "tool-1",
        delta: "all green",
      });
      notify("item/completed", {
        threadId: message.params.threadId,
        turnId,
        item: { ...started, status: "completed", aggregatedOutput: "all green", exitCode: 0 },
        completedAtMs: Date.now(),
      });
      return complete(turnId, message.params.threadId, "Done");
    }
    if (text === "usage-limit" || text === "usage-limit-no-reset") {
      notify("error", {
        threadId: message.params.threadId,
        turnId,
        willRetry: false,
        error: {
          message: "raw quota error",
          codexErrorInfo: "usageLimitExceeded",
          additionalDetails: text.endsWith("no-reset") ? null : "Resets at 18:30 UTC.",
        },
      });
      return complete(turnId, message.params.threadId, "");
    }
    if (text === "raw-error") {
      notify("error", {
        threadId: message.params.threadId,
        turnId,
        willRetry: false,
        error: { message: "EXACT_PROVIDER_FAILURE", codexErrorInfo: "other", additionalDetails: null },
      });
      return complete(turnId, message.params.threadId, "");
    }
    if (text === "approvals") {
      void approvalSequence(message.params.threadId, turnId);
      return;
    }
    complete(turnId, message.params.threadId, "Hello", text);
    return;
  }
  if (message.method === "turn/interrupt") {
    reply(message.id, {});
    notify("turn/completed", {
      threadId: message.params.threadId,
      turn: completedTurn(message.params.turnId),
    });
  }
});

async function approvalSequence(threadId, turnId) {
  const file = await request("item/fileChange/requestApproval", {
    threadId,
    turnId,
    itemId: "file-approval",
    startedAtMs: Date.now(),
    grantRoot: `${lastThreadStart.cwd}\\changed.txt`,
  });
  const command = await request("item/commandExecution/requestApproval", {
    threadId,
    turnId,
    itemId: "command-approval",
    startedAtMs: Date.now(),
    environmentId: null,
    command: "npm test",
    cwd: lastThreadStart.cwd,
  });
  complete(turnId, threadId, `file:${file};command:${command}`);
}
function request(method, params) {
  const id = `provider-${Date.now()}-${Math.random()}`;
  process.stdout.write(`${JSON.stringify({ id, method, params })}\n`);
  return new Promise((resolve) => {
    pendingApproval = { id, resolve };
  });
}
function complete(turnId, threadId, text, userText) {
  const found = seededThreads.find((item) => item.id === threadId);
  if (found && userText)
    found.turns.push({
      id: turnId,
      itemsView: "full",
      status: "completed",
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1000,
      items: [
        {
          type: "userMessage",
          id: `user-${turnId}`,
          clientId: null,
          content: [{ type: "text", text: userText, text_elements: [] }],
        },
        { type: "agentMessage", id: `agent-${turnId}`, text, phase: null, memoryCitation: null },
      ],
    });
  if (text) notify("item/agentMessage/delta", { threadId, turnId, itemId: `agent-${turnId}`, delta: text });
  notify("turn/completed", { threadId, turn: completedTurn(turnId) });
}
function completedTurn(id) {
  return {
    id,
    items: [],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1000,
  };
}
function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}
function reject(id, error) {
  process.stdout.write(`${JSON.stringify({ id, error })}\n`);
}
function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ method, params })}\n`);
}
function model(id, displayName, isDefault = false) {
  return {
    id,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName,
    description: "",
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "medium",
    inputModalities: ["text"],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault,
  };
}
function thread(id, title, cwd, updatedAt) {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: title,
    ephemeral: false,
    isPinned: false,
    modelProvider: "openai",
    createdAt: updatedAt - 10,
    updatedAt,
    recencyAt: updatedAt,
    status: { type: "idle" },
    path: null,
    cwd,
    cliVersion: "1.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: title,
    turns: [],
  };
}
