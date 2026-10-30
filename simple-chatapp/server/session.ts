import type { WSClient } from "./types.js";
import { runChatTurn } from "./chat-turn.js";
export class Session {
  private subscribers = new Set<WSClient>();
  constructor(public readonly chatId: string) {}
  async sendMessage(content: string) {
    return runChatTurn({ chatId: this.chatId, content }, (message) =>
      this.broadcast(message),
    );
  }
  subscribe(client: WSClient) {
    this.subscribers.add(client);
    client.sessionId = this.chatId;
  }
  unsubscribe(client: WSClient) {
    this.subscribers.delete(client);
  }
  hasSubscribers() {
    return this.subscribers.size > 0;
  }
  private broadcast(message: unknown) {
    for (const client of this.subscribers)
      if (client.readyState === client.OPEN)
        client.send(JSON.stringify(message));
  }
  close() {
    this.subscribers.clear();
  }
}
