import type { Turn } from "../../schemas/v2/Turn.js";
import type { ChatState } from "../protocol.js";

export interface ChatRecord extends ChatState {
  turns: Turn[];
}

export class ChatRegistry {
  private readonly chats = new Map<string, ChatRecord>();
  private nextChat = 1;

  create(workspace: string | undefined, defaultModel: string | undefined): ChatRecord {
    const chat: ChatRecord = {
      id: `new-${this.nextChat++}`,
      workspace,
      model: defaultModel,
      accessMode: "manual",
      turns: [],
    };
    this.chats.set(chat.id, chat);
    return chat;
  }

  set(chat: ChatRecord): void {
    this.chats.set(chat.id, chat);
  }

  get(id: string): ChatRecord | undefined {
    return this.chats.get(id);
  }

  values(): IterableIterator<ChatRecord> {
    return this.chats.values();
  }

  require(id: string): ChatRecord {
    const chat = this.chats.get(id);
    if (!chat) throw new Error(`Unknown Chat: ${id}`);
    return chat;
  }

  findByThread(threadId: string): ChatRecord | undefined {
    return [...this.chats.values()].find((chat) => chat.threadId === threadId);
  }

  public(chat: ChatRecord): ChatState {
    const { turns: _turns, ...state } = chat;
    return state;
  }

  failActive(message: string, report: (chatId: string, message: string) => void): void {
    for (const chat of this.chats.values())
      if (chat.turnId) {
        report(chat.id, message);
        chat.turnId = undefined;
      }
  }
}
