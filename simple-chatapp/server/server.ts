import "dotenv/config";
import express from "express";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { WSClient } from "./types.js";
import { Session } from "./session.js";
import {
  listChats,
  createChat,
  getChat,
  deleteChat,
  getMessages,
  fail,
} from "./chat-operations.js";
import { runChatTurn, forgetSession } from "./chat-turn.js";
import { agentMode } from "./ai-client.js";
import { getSpans, operation, requestContext } from "./telemetry.js";
function allowedOrigin(origin: string | undefined, host: string | undefined) {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
const app = express();
app.use(express.json({ limit: "16kb" }));
app.use((req, res, next) => {
  if (
    req.headers.origin &&
    new URL(req.headers.origin).host !== req.headers.host
  )
    return res.sendStatus(403);
  next();
});
const sessions = new Map<string, Session>();
const errorStatus = (error: unknown) =>
  typeof error === "object" && error && "status" in error
    ? Number(error.status)
    : 500;
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed";
async function respond(
  req: express.Request,
  res: express.Response,
  work: () => unknown,
  status = 200,
) {
  await requestContext(req.headers, async (ids) => {
    res.setHeader("x-tracepath-run", ids.runId);
    try {
      res.status(status).json(await work());
    } catch (error) {
      res.status(errorStatus(error)).json({ error: errorMessage(error) });
    }
  });
}
export async function health() {
  return operation("api.health", () => ({
    ok: true,
    mode: agentMode,
    revision: process.env.TRACEPATH_REVISION ?? "unversioned",
  }));
}
app.get("/health", async (req, res) => {
  await respond(req, res, health);
});
app.get("/api/chats", async (req, res) => {
  await respond(req, res, listChats);
});
app.post("/api/chats", async (req, res) => {
  await respond(req, res, () => createChat(req.body?.title), 201);
});
app.get("/api/chats/:id", async (req, res) => {
  await respond(req, res, () => getChat(req.params.id));
});
app.delete("/api/chats/:id", async (req, res) => {
  await respond(req, res, async () => {
    const result = await deleteChat(req.params.id);
    sessions.get(req.params.id)?.close();
    sessions.delete(req.params.id);
    forgetSession(req.params.id);
    return result;
  });
});
app.get("/api/chats/:id/messages", async (req, res) => {
  await respond(req, res, () => getMessages(req.params.id));
});
app.post("/api/chat-turns", async (req, res) => {
  await respond(req, res, () => runChatTurn(req.body));
});
app.get("/tracepath/spans/:runId", (req, res) => {
  const expected = Buffer.from(process.env.TRACEPATH_DEMO_TOKEN ?? "");
  const supplied = Buffer.from(String(req.headers["x-demo-token"] ?? ""));
  if (
    !expected.length ||
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  )
    return res.sendStatus(401);
  res.json(getSpans(req.params.runId));
});
const dist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist",
);
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get("/", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}
const server = createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: 16384,
  verifyClient: ({ origin, req }: { origin: string; req: IncomingMessage }) =>
    allowedOrigin(origin, req.headers.host),
});
wss.on("connection", (ws: WSClient) => {
  ws.isAlive = true;
  ws.send(JSON.stringify({ type: "connected", mode: agentMode }));
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  ws.on("message", async (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (
        !message ||
        !["subscribe", "chat"].includes(message.type) ||
        typeof message.chatId !== "string"
      )
        throw fail(400, "Invalid WebSocket message");
      await requestContext(
        {
          "x-tracepath-run": message.runId,
          "x-tracepath-request": message.requestId,
        },
        async (ids) => {
          try {
            if (message.type === "subscribe") await getChat(message.chatId);
            let session = sessions.get(message.chatId);
            if (!session) {
              session = new Session(message.chatId);
              sessions.set(message.chatId, session);
            }
            for (const other of sessions.values()) other.unsubscribe(ws);
            session.subscribe(ws);
            if (message.type === "subscribe")
              ws.send(
                JSON.stringify({
                  type: "history",
                  messages: await getMessages(message.chatId),
                  chatId: message.chatId,
                }),
              );
            else {
              await session.sendMessage(message.content);
              ws.send(JSON.stringify({ type: "trace", ...ids }));
            }
          } catch (error) {
            ws.send(
              JSON.stringify({
                type: "error",
                error: errorMessage(error),
                status: errorStatus(error),
                ...ids,
              }),
            );
          }
        },
      );
    } catch (error) {
      ws.send(JSON.stringify({ type: "error", error: errorMessage(error) }));
    }
  });
  ws.on("close", () => {
    for (const session of sessions.values()) session.unsubscribe(ws);
  });
});
const heartbeat = setInterval(() => {
  for (const client of wss.clients as Set<WSClient>) {
    if (!client.isAlive) client.terminate();
    else {
      client.isAlive = false;
      client.ping();
    }
  }
}, 30000);
wss.on("close", () => clearInterval(heartbeat));
server.listen(
  Number(process.env.PORT ?? 3001),
  process.env.HOST ?? "127.0.0.1",
  () =>
    console.log(
      `Chat demo: port ${(server.address() as AddressInfo).port}, mode ${agentMode}`,
    ),
);
