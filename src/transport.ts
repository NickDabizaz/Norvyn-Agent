import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import type { InitializeParams } from "../schemas/InitializeParams.js";
import type { ServerNotificationEnvelope } from "../schemas/ServerNotificationEnvelope.js";
import type { ThreadStartParams } from "../schemas/v2/ThreadStartParams.js";
import type { TurnStartParams } from "../schemas/v2/TurnStartParams.js";

type RpcMessage = { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };

export class Transport extends EventEmitter {
  private readonly process;
  private readonly responses = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 1;

  private constructor(command: string, args: string[]) {
    super();
    this.process = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.process.once("error", (error) => this.emit("error", error));
    this.process.stderr.on("data", (chunk) => this.emit("diagnostic", chunk.toString()));
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => this.receive(JSON.parse(line) as RpcMessage));
  }

  static async connect(): Promise<Transport> {
    const command = process.env.NORVYN_PROVIDER_COMMAND ?? "codex";
    const args = process.env.NORVYN_PROVIDER_ARGUMENTS ? JSON.parse(process.env.NORVYN_PROVIDER_ARGUMENTS) as string[] : ["app-server"];
    const transport = new Transport(command, args);
    const params: InitializeParams = { clientInfo: { name: "norvyn", title: "Norvyn", version: "0.1.0" }, capabilities: null };
    await transport.request("initialize", params);
    transport.notify("initialized", {});
    return transport;
  }

  async startThread(workspace: string): Promise<string> {
    const params: ThreadStartParams = { cwd: workspace };
    const result = await this.request("thread/start", params) as { thread: { id: string } };
    return result.thread.id;
  }

  async startTurn(threadId: string, text: string): Promise<string> {
    const params: TurnStartParams = { threadId, input: [{ type: "text", text, text_elements: [] }] };
    const result = await this.request("turn/start", params) as { turn: { id: string } };
    return result.turn.id;
  }

  close() { this.process.kill(); }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.send({ id, method, params });
    return new Promise((resolve, reject) => this.responses.set(id, { resolve, reject }));
  }

  private notify(method: string, params: unknown) { this.send({ method, params }); }
  private send(message: RpcMessage) { this.process.stdin.write(`${JSON.stringify(message)}\n`); }
  private receive(message: RpcMessage) {
    if (message.id !== undefined) {
      const pending = this.responses.get(message.id);
      if (!pending) return;
      this.responses.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
      return;
    }
    if (message.method) this.emit("notification", message as ServerNotificationEnvelope);
  }
}
