import readline from "node:readline";

let initialized = false;
let startedThread = false;
let threadCount = 0;

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    return;
  }
  if (message.method === "initialized") { initialized = true; return; }
  if (message.method === "thread/start") {
    if (!initialized) throw new Error("thread/start before initialized");
    startedThread = true;
    threadCount += 1;
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: `thread-${threadCount}` } } })}\n`);
    return;
  }
  if (message.method === "turn/start") {
    if (!startedThread) throw new Error("turn/start before thread/start");
    const turnId = `turn-${message.params.threadId}`;
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { turn: { id: turnId } } })}\n`);
    process.stdout.write(`${JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "Hello" } })}\n`);
    process.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { turn: { id: turnId } } })}\n`);
  }
});
