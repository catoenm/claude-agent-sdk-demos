import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import type { ObservedSpan } from "../server/telemetry.js";

test(
  "HTTP and WebSocket turns retain source-bound, independent traces across failures and concurrency",
  { timeout: 20000 },
  async (t) => {
    const token = randomUUID();
    const revision = "a".repeat(40);
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "server/server.ts"],
      {
        env: {
          ...process.env,
          PORT: "0",
          HOST: "127.0.0.1",
          AGENT_MODE: "mock",
          TRACEPATH_REVISION: revision,
          TRACEPATH_DEMO_TOKEN: token,
          TURN_TIMEOUT_MS: "900",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    t.after(() => {
      child.kill("SIGTERM");
    });
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const port = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Server startup timed out: " + stderr)),
        10000,
      );
      child.stdout.on("data", (data) => {
        const match = String(data).match(/port (\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited ${code}: ${stderr}`));
      });
    });
    const origin = `http://127.0.0.1:${port}`;
    const call = async (
      path: string,
      body?: unknown,
      runId = randomUUID(),
      requestId = "one",
      method = body === undefined ? "GET" : "POST",
    ) => {
      const response = await fetch(origin + path, {
        method,
        headers: {
          "content-type": "application/json",
          "x-tracepath-run": runId,
          "x-tracepath-request": requestId,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, body: await response.json(), runId };
    };
    const spans = async (runId: string): Promise<ObservedSpan[]> =>
      (
        await fetch(`${origin}/tracepath/spans/${runId}`, {
          headers: { "x-demo-token": token },
        })
      ).json();
    const verify = (items: ObservedSpan[], expected: string[]) => {
      assert.deepEqual(
        items.map((s) => s.operation).sort(),
        [...expected].sort(),
      );
      assert.equal(new Set(items.map((s) => s.traceId)).size, 1);
      assert.equal(items.filter((s) => !s.parentSpanId).length, 1);
      for (const span of items) {
        assert.equal(span.revision, revision);
        assert.equal(span.service, "chat-api");
        assert.ok(span.endMs! >= span.startMs && span.durationMs! >= 0);
        if (span.parentSpanId)
          assert.ok(
            items.some((parent) => parent.spanId === span.parentSpanId),
          );
      }
    };
    const successOps = [
      "chat.turn",
      "chat.create",
      "store.user",
      "agent.respond",
      "agent.mock",
      "store.assistant",
    ];
    assert.equal((await call("/health")).body.mode, "mock");
    assert.deepEqual((await call("/api/chats")).body, []);
    const first = await call("/api/chat-turns", { content: "Hello" });
    assert.equal(first.status, 200);
    assert.equal(first.body.mode, "mock");
    assert.match(first.body.message.content, /Mock agent/);
    verify(await spans(first.runId), successOps);
    const messages = await call(`/api/chats/${first.body.chatId}/messages`);
    assert.deepEqual(
      messages.body.map((m: { role: string }) => m.role),
      ["user", "assistant"],
    );
    const failed = await call("/api/chat-turns", {
      content: "Fail",
      mockFailure: true,
    });
    assert.equal(failed.status, 502);
    verify(
      await spans(failed.runId),
      successOps.filter((id) => id !== "store.assistant"),
    );
    assert.ok(
      (await spans(failed.runId)).find((s) => s.operation === "chat.turn")
        ?.error,
    );
    assert.equal((await call("/api/chat-turns", { content: "" })).status, 400);
    assert.equal((await call("/api/chats/missing")).status, 404);
    const concurrentId = randomUUID();
    const concurrent = await Promise.all(
      [1, 2, 3].map((n) =>
        call(
          "/api/chat-turns",
          { content: `Concurrent ${n}` },
          concurrentId,
          `r${n}`,
        ),
      ),
    );
    assert.ok(concurrent.every((r) => r.status === 200));
    const all = await spans(concurrentId);
    for (let n = 1; n <= 3; n++)
      verify(
        all.filter((s) => s.requestId === `r${n}`),
        successOps,
      );
    const roots = all.filter((s) => !s.parentSpanId);
    assert.equal(new Set(roots.map((s) => s.traceId)).size, 3);
    assert.ok(
      Math.max(...roots.map((s) => s.startMs)) <
        Math.min(...roots.map((s) => s.endMs!)),
    );
    const busyId = randomUUID();
    const busy = call(
      "/api/chat-turns",
      { chatId: first.body.chatId, content: "Slow", mockDelayMs: 600 },
      busyId,
    );
    for (
      let n = 0;
      n < 30 &&
      !(await spans(busyId)).some((s) => s.operation === "agent.mock");
      n++
    )
      await delay(10);
    assert.ok(
      (await spans(busyId)).some(
        (s) => s.operation === "agent.mock" && s.endMs === undefined,
      ),
      "Observe actual running work",
    );
    assert.equal(
      (
        await call("/api/chat-turns", {
          chatId: first.body.chatId,
          content: "Collision",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await call(
          `/api/chats/${first.body.chatId}`,
          undefined,
          randomUUID(),
          "one",
          "DELETE",
        )
      ).status,
      409,
    );
    assert.equal((await busy).status, 200);
    const timeout = await call("/api/chat-turns", {
      chatId: first.body.chatId,
      content: "Timeout",
      mockDelayMs: 1300,
    });
    assert.equal(timeout.status, 504);
    await delay(500);
    assert.ok(
      !(await spans(timeout.runId)).some(
        (s) => s.operation === "store.assistant",
      ),
    );
    const chat = await call("/api/chats", { title: "WebSocket test" });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    t.after(() => ws.close());
    const events: Record<string, any>[] = [];
    ws.on("message", (data) => events.push(JSON.parse(String(data))));
    await once(ws, "open");
    const wsRun = randomUUID();
    ws.send(
      JSON.stringify({
        type: "chat",
        chatId: chat.body.id,
        content: "From the browser",
        runId: wsRun,
        requestId: "ws-one",
      }),
    );
    for (let n = 0; n < 100 && !events.some((e) => e.type === "trace"); n++)
      await delay(20);
    assert.ok(
      events.some(
        (e) =>
          e.type === "assistant_message" && e.content.includes("Mock agent"),
      ),
    );
    assert.ok(events.some((e) => e.type === "trace" && e.runId === wsRun));
    verify(
      await spans(wsRun),
      successOps.map((id) => (id === "chat.create" ? "chat.get" : id)),
    );
    ws.close();
    assert.equal(
      (
        await call(
          `/api/chats/${chat.body.id}`,
          undefined,
          randomUUID(),
          "one",
          "DELETE",
        )
      ).status,
      200,
    );
    assert.equal((await call(`/api/chats/${chat.body.id}`)).status, 404);
    assert.equal(
      (await fetch(`${origin}/tracepath/spans/${wsRun}`)).status,
      401,
    );
  },
);
