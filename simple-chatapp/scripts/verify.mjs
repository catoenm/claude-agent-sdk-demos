import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readState, git } from "./support.mjs";
const state = readState();
assert.equal(state.revision, git("rev-parse", "HEAD"));
assert.equal(git("status", "--porcelain"), "");
assert.equal(
  state.mode,
  "mock",
  "This repeatable verification intentionally uses the mock backend",
);
const origin = "http://127.0.0.1:4420";
const health = await (await fetch(origin + "/health")).json();
assert.equal(health.revision, state.revision);
assert.equal(health.mode, "mock");
const runId = randomUUID();
const payloads = [
  { content: "First chat" },
  { content: "Expected failure", mockFailure: true },
  { content: "Third chat" },
];
const results = await Promise.all(
  payloads.map(async (body, index) => {
    const response = await fetch(origin + "/api/chat-turns", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tracepath-run": runId,
        "x-tracepath-request": `request-${index + 1}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, body: await response.json() };
  }),
);
assert.deepEqual(
  results.map((r) => r.status),
  [200, 502, 200],
);
const spans = await (
  await fetch(`${origin}/tracepath/spans/${runId}`, {
    headers: { "x-demo-token": state.token },
  })
).json();
const roots = spans.filter((s) => s.operation === "chat.turn");
assert.equal(roots.length, 3);
assert.equal(new Set(roots.map((s) => s.traceId)).size, 3);
assert.ok(
  Math.max(...roots.map((s) => s.startMs)) <
    Math.min(...roots.map((s) => s.endMs)),
);
for (let index = 0; index < 3; index++) {
  const group = spans.filter((s) => s.requestId === `request-${index + 1}`);
  assert.equal(group.filter((s) => !s.parentSpanId).length, 1);
  assert.equal(group.length, index === 1 ? 5 : 6);
  assert.ok(
    group.every((s) => s.revision === state.revision && s.endMs >= s.startMs),
  );
  assert.ok(group.some((s) => s.operation === "agent.mock"));
  assert.ok(!group.some((s) => s.operation === "agent.claude"));
  if (index === 1)
    assert.ok(!group.some((s) => s.operation === "store.assistant"));
}
writeFileSync(
  ".runtime/recording.json",
  JSON.stringify(
    { runId, revision: state.revision, mode: state.mode, results, spans },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  `Verified Docker UI server and 3 concurrent turns (200/502/200), ${spans.length} real measured spans, mock agent explicitly identified. Recording: ${runId}`,
);
