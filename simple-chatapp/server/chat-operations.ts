import { chatStore } from "./chat-store.js";
import { operation } from "./telemetry.js";
export const activeChats = new Set<string>();
export const fail = (status: number, message: string) =>
  Object.assign(new Error(message), { status });
export async function listChats() {
  return operation("chat.list", () => chatStore.getAllChats());
}
export async function createChat(title?: string) {
  return operation("chat.create", () => {
    if (
      title !== undefined &&
      (typeof title !== "string" || title.length > 120)
    )
      throw fail(400, "Invalid title");
    return chatStore.createChat(title);
  });
}
export async function getChat(id: string) {
  return operation("chat.get", () => {
    const chat = chatStore.getChat(id);
    if (!chat) throw fail(404, "Chat not found");
    return chat;
  });
}
export async function deleteChat(id: string) {
  return operation("chat.delete", () => {
    if (activeChats.has(id))
      throw fail(409, "A turn is still running in this chat");
    if (!chatStore.deleteChat(id)) throw fail(404, "Chat not found");
    return { success: true };
  });
}
export async function getMessages(id: string) {
  return operation("chat.messages", () => {
    if (!chatStore.getChat(id)) throw fail(404, "Chat not found");
    return chatStore.getMessages(id);
  });
}
export async function appendUser(chatId: string, content: string) {
  return operation("store.user", () =>
    chatStore.addMessage(chatId, { role: "user", content }),
  );
}
export async function appendAssistant(chatId: string, content: string) {
  return operation("store.assistant", () =>
    chatStore.addMessage(chatId, { role: "assistant", content }),
  );
}
