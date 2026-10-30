import { query } from "@anthropic-ai/claude-agent-sdk";
import { setTimeout as delay } from "node:timers/promises";
import { operation } from "./telemetry.js";
import { fail } from "./chat-operations.js";
export const agentMode = process.env.AGENT_MODE ?? "mock";
if (!["mock", "claude"].includes(agentMode))
  throw new Error("AGENT_MODE must be mock or claude");
export interface AgentInput {
  content: string;
  mockFailure?: boolean;
  mockDelayMs?: number;
}
export interface AgentReply {
  text: string;
  mode: string;
  sessionId?: string;
}
export async function mockReply(
  input: AgentInput,
  controller: AbortController,
): Promise<AgentReply> {
  return operation("agent.mock", async () => {
    await delay(input.mockDelayMs ?? 350, undefined, {
      signal: controller.signal,
    });
    if (input.mockFailure) throw fail(502, "Controlled mock agent failure");
    return {
      text: `[Mock agent — no model called] You said: ${input.content}`,
      mode: "mock",
    };
  });
}
export async function claudeReply(
  input: AgentInput,
  controller: AbortController,
  resume?: string,
): Promise<AgentReply> {
  return operation("agent.claude", async () => {
    if (!process.env.ANTHROPIC_API_KEY)
      throw fail(503, "Set ANTHROPIC_API_KEY for Claude mode");
    const output = query({
      prompt: input.content,
      options: {
        model: process.env.CLAUDE_MODEL ?? "haiku",
        maxTurns: 4,
        maxBudgetUsd: 0.1,
        cwd: process.env.AGENT_WORKDIR ?? process.cwd(),
        abortController: controller,
        ...(resume ? { resume } : {}),
        tools: [],
        settingSources: [],
        allowedTools: [],
        canUseTool: async () => ({
          behavior: "deny" as const,
          message: "Tools are disabled in this tracing fixture",
        }),
        systemPrompt:
          "You are a concise chat assistant. Answer without using tools.",
      },
    });
    let text = "";
    let sessionId: string | undefined;
    try {
      for await (const message of output) {
        if ("session_id" in message) sessionId = message.session_id;
        if (message.type === "assistant")
          for (const block of message.message.content)
            if (block.type === "text") text += block.text;
        if (message.type === "result" && message.subtype !== "success")
          throw fail(502, "Claude SDK turn failed");
      }
    } finally {
      await output.return(undefined);
    }
    if (!text) throw fail(502, "Claude returned no text");
    return { text, mode: "claude", sessionId };
  });
}
export async function respondToMessage(
  input: AgentInput,
  controller: AbortController,
  resume?: string,
) {
  return operation("agent.respond", () =>
    agentMode === "mock"
      ? mockReply(input, controller)
      : claudeReply(input, controller, resume),
  );
}
