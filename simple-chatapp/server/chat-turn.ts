import { operation } from "./telemetry.js";
import {
  activeChats,
  appendUser,
  appendAssistant,
  createChat,
  getChat,
  fail,
} from "./chat-operations.js";
import { agentMode, respondToMessage } from "./ai-client.js";
const resumeIds = new Map<string, string>();
export function forgetSession(id: string) {
  resumeIds.delete(id);
}
function validate(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw fail(400, "Expected a JSON object");
  const value = input as Record<string, unknown>;
  if (
    typeof value.content !== "string" ||
    !value.content.trim() ||
    value.content.length > 4000
  )
    throw fail(400, "Content must be 1–4000 characters");
  if (
    value.chatId !== undefined &&
    (typeof value.chatId !== "string" || value.chatId.length > 100)
  )
    throw fail(400, "Invalid chat ID");
  if (value.mockFailure !== undefined && typeof value.mockFailure !== "boolean")
    throw fail(400, "Invalid mockFailure");
  if (
    value.mockDelayMs !== undefined &&
    (typeof value.mockDelayMs !== "number" ||
      !Number.isInteger(value.mockDelayMs) ||
      value.mockDelayMs < 0 ||
      value.mockDelayMs > 15000)
  )
    throw fail(400, "mockDelayMs must be 0–15000");
  if (
    agentMode === "claude" &&
    (value.mockFailure !== undefined || value.mockDelayMs !== undefined)
  )
    throw fail(400, "Mock controls are unavailable in Claude mode");
  return value as {
    content: string;
    chatId?: string;
    mockFailure?: boolean;
    mockDelayMs?: number;
  };
}
export async function runChatTurn(
  raw: unknown,
  notify: (message: Record<string, unknown>) => void = () => {},
) {
  return operation("chat.turn", async () => {
    const input = validate(raw);
    const chat = input.chatId
      ? await getChat(input.chatId)
      : await createChat();
    if (activeChats.has(chat.id))
      throw fail(409, "A turn is still running in this chat");
    activeChats.add(chat.id);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Number(process.env.TURN_TIMEOUT_MS ?? 8000),
    );
    try {
      await appendUser(chat.id, input.content);
      notify({ type: "user_message", content: input.content, chatId: chat.id });
      const reply = await respondToMessage(
        input,
        controller,
        resumeIds.get(chat.id),
      );
      if (controller.signal.aborted) throw fail(504, "Agent turn timed out");
      if (reply.sessionId) resumeIds.set(chat.id, reply.sessionId);
      const message = await appendAssistant(chat.id, reply.text);
      notify({
        type: "assistant_message",
        content: reply.text,
        chatId: chat.id,
      });
      notify({
        type: "result",
        success: true,
        chatId: chat.id,
        mode: reply.mode,
      });
      return { chatId: chat.id, message, mode: reply.mode };
    } catch (error) {
      if (controller.signal.aborted) throw fail(504, "Agent turn timed out");
      throw error;
    } finally {
      clearTimeout(timeout);
      activeChats.delete(chat.id);
    }
  });
}
