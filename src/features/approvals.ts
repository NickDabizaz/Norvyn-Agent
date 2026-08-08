import type { ServerRequest } from "../../schemas/ServerRequest.js";
import type { ChatState, ServerEvent } from "../protocol.js";

export interface ApprovalResponder {
  answerRequest(id: number | string, result: { decision: "accept" | "decline" }): void;
}

export class ApprovalFeature {
  private readonly pending = new Map<number | string, NodeJS.Timeout>();

  constructor(
    private readonly timeoutMs: number,
    private readonly emit: (
      event: Extract<ServerEvent, { type: "approval/request" | "approval/expired" }>,
    ) => void,
  ) {}

  handle(request: ServerRequest, adapter: ApprovalResponder, chat?: ChatState): void {
    if (
      request.method !== "item/fileChange/requestApproval" &&
      request.method !== "item/commandExecution/requestApproval"
    ) {
      adapter.answerRequest(request.id, { decision: "decline" });
      return;
    }

    const isFileChange = request.method === "item/fileChange/requestApproval";
    const kind = isFileChange ? "file-change" : "command-execution";
    const shouldApprove =
      chat?.accessMode === "auto" || (chat?.accessMode === "auto-edit" && kind === "file-change");
    if (shouldApprove) {
      adapter.answerRequest(request.id, { decision: "accept" });
      return;
    }

    const target = isFileChange
      ? (request.params.grantRoot ?? request.params.reason ?? request.params.itemId)
      : (request.params.command ?? request.params.reason ?? request.params.itemId);
    const timeout = setTimeout(() => {
      this.pending.delete(request.id);
      adapter.answerRequest(request.id, { decision: "decline" });
      this.emit({ type: "approval/expired", requestId: request.id });
    }, this.timeoutMs);
    this.pending.set(request.id, timeout);
    this.emit({ type: "approval/request", requestId: request.id, chatId: chat?.id, kind, target });
  }

  respond(requestId: number | string, approved: boolean, adapter: ApprovalResponder): void {
    const timeout = this.pending.get(requestId);
    if (!timeout) throw new Error("That approval request is no longer pending.");
    clearTimeout(timeout);
    this.pending.delete(requestId);
    adapter.answerRequest(requestId, { decision: approved ? "accept" : "decline" });
  }

  close(): void {
    for (const timeout of this.pending.values()) clearTimeout(timeout);
    this.pending.clear();
  }
}
