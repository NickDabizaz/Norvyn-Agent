import type { ServerRequest } from "../../schemas/ServerRequest.js";
import type { ChatState, ServerEvent } from "../protocol.js";

export interface ApprovalResponder {
  answerRequest(id: number | string, result: { decision: "accept" | "decline" }): void;
}

export class ApprovalFeature {
  private readonly pending = new Map<
    number | string,
    { timeout: NodeJS.Timeout; adapter: ApprovalResponder }
  >();

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
    this.invalidate(request.id);
    const timeout = setTimeout(() => {
      this.pending.delete(request.id);
      adapter.answerRequest(request.id, { decision: "decline" });
      this.emit({ type: "approval/expired", requestId: request.id });
    }, this.timeoutMs);
    this.pending.set(request.id, { timeout, adapter });
    this.emit({ type: "approval/request", requestId: request.id, chatId: chat?.id, kind, target });
  }

  respond(requestId: number | string, approved: boolean): void {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error("That approval request is no longer pending.");
    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    pending.adapter.answerRequest(requestId, { decision: approved ? "accept" : "decline" });
  }

  invalidate(requestId?: number | string): void {
    const entries =
      requestId === undefined
        ? [...this.pending.entries()]
        : this.pending.has(requestId)
          ? ([[requestId, this.pending.get(requestId)!]] as const)
          : [];
    for (const [id, pending] of entries) {
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      try {
        pending.adapter.answerRequest(id, { decision: "decline" });
      } catch {
        // The originating Provider may already have exited. Never forward this decision to a replacement.
      }
      this.emit({ type: "approval/expired", requestId: id });
    }
  }

  close(): void {
    for (const pending of this.pending.values()) clearTimeout(pending.timeout);
    this.pending.clear();
  }
}
