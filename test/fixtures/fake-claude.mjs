import readline from "node:readline";

// Stands in for the Claude Code CLI. It speaks the same three surfaces Norvyn depends on: `--version`,
// `auth status` / `auth login`, and the headless stream-json session. No Local Session is ever required.
const args = process.argv.slice(2);

if (args[0] === "--version") {
  process.stdout.write("2.1.220 (Claude Code)\n");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  if (process.env.NORVYN_FAKE_SIGNED_OUT === "1") {
    process.stdout.write(`${JSON.stringify({ loggedIn: false })}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `${JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" })}\n`,
  );
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "login")
  process.exit(process.env.NORVYN_FAKE_LOGIN_MODE === "fails" ? 1 : 0);

const sessionId = value("--session-id") ?? value("--resume") ?? "unknown-session";
const model = value("--model") ?? "unknown-model";
let messageCount = 0;

// The real CLI emits this before accepting input; Norvyn ignores it, so it is here to prove it does.
emit({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  model,
  permissionMode: value("--permission-mode") ?? "manual",
  cwd: process.cwd(),
});

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const text = message.message?.content?.find((part) => part.type === "text")?.text ?? "";
  const id = `msg_${++messageCount}`;

  if (text === "claude-denied") {
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Stopped",
      permission_denials: [{ tool_name: "Bash", tool_input: { command: "npm test" } }],
    });
    return;
  }

  if (text === "claude-error") {
    emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "Turn failed." });
    return;
  }

  if (text === "claude-tools") {
    emit({
      type: "assistant",
      message: {
        id,
        content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "npm test" } }],
      },
    });
    emit({
      type: "user",
      message: {
        id: `${id}-result`,
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "all green" }],
      },
    });
    emit({ type: "result", subtype: "success", is_error: false, result: "Done" });
    return;
  }

  if (text === "claude-inspect") {
    emit({
      type: "assistant",
      message: { id, content: [{ type: "text", text: JSON.stringify({ args, cwd: process.cwd() }) }] },
    });
    emit({ type: "result", subtype: "success", is_error: false, result: "" });
    return;
  }

  emit({
    type: "assistant",
    message: {
      id,
      content: [
        { type: "thinking", thinking: "Checked the Workspace." },
        { type: "text", text: `Hello from ${model}` },
      ],
    },
  });
  emit({ type: "result", subtype: "success", is_error: false, result: "Hello" });
});

function value(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify({ ...event, session_id: sessionId })}\n`);
}
