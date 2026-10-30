# Instrumented Simple Chat App

This is a fork of Anthropic's **Simple Chat App**, retaining its React interface, Express API, WebSocket chat protocol, and in-memory chat store. Changes are isolated to this example plus the root manifest/documentation. Other upstream examples are unchanged.

## Run the reviewed fixture

Requires Git, Node.js 24+, and Docker Compose:

```sh
git clone https://github.com/catoenm/claude-agent-sdk-demos.git
cd claude-agent-sdk-demos/simple-chatapp
npm run demo:start
# Open http://127.0.0.1:4420
npm run demo:verify
npm run demo:stop
```

The default is **mock mode**. It needs no credentials and makes no model calls. The UI banner and every mock reply say so. OpenTelemetry still measures real server execution and the mock's deliberate delay. Docker uses an isolated `tracepath-chat-demo` project, a loopback-only host port, and a non-root user. It does not touch Tracepath's other demos. There is no automatic idle shutdown; stop it when finished.

Startup requires a clean Git checkout, embeds its revision in every span, and generates a trace-read token in ignored `.runtime/state.json`. Commit edits and restart before recording. Revision metadata is not cryptographic attestation. Only this reviewed checkout is launched; importing an arbitrary repo must never implicitly execute it.

## What is traced

```text
POST /api/chat-turns or WebSocket chat event
  → runChatTurn
      → create/read chat
      → append user message
      → respondToMessage
          → mockReply OR claudeReply
      → append assistant message
```

All seven business HTTP routes have operation wrappers: health, list/create/read/delete chats, list messages, and the new turn adapter. The existing browser still sends turns over WebSocket. Both transports use the same `runChatTurn` function and stable operation ID.

`POST /api/chat-turns` accepts:

```json
{ "content": "Explain how tracing works." }
```

Omitting `chatId` creates a new chat. Supplying `chatId` continues one. Successful requests return `chatId`, `message`, and `mode`. Input is limited to 4,000 characters and 16 KiB JSON bodies. Different chats can run concurrently. A second turn or deletion during an active turn in the same chat returns 409.

Mock-only controls:

```json
{"content":"Show a failure", "mockFailure":true}
{"content":"Show a timeout", "mockDelayMs":10000}
```

Failures return 502; the default eight-second timeout returns 504 and cancels the mock delay. Failed prompts remain as user messages but never get a fabricated assistant reply. Mock controls are rejected in Claude mode. Invalid requests return 400; missing chats return 404.

Callers may send `x-tracepath-run` (UUID) and `x-tracepath-request`; otherwise the server assigns IDs and returns the run ID in the HTTP response header. WebSocket chat messages may include `runId` and `requestId`, with the IDs returned in a final `trace` event or error event. Every turn has its own trace; spans within it retain parentage. WebSocket subscribe/history events are separate operations, not part of the later agent turn.

Read `GET /tracepath/spans/:runId` with the local token as `x-demo-token`. The server retains up to 5,000 spans, including start events for currently running work. It uses the OpenTelemetry SDK with a small in-memory lifecycle collector, **not** an OTLP exporter. Records include operation, source revision, service, run/request IDs, parent span ID, measured timestamps, and errors. `npm run demo:verify` saves a recording to ignored `.runtime/recording.json`.

## Real Claude mode (not verified with credentials in this fork)

Copy `.env.example` to ignored `.env`, set `AGENT_MODE=claude` and `ANTHROPIC_API_KEY`, then restart. `CLAUDE_MODEL` defaults to the SDK's `haiku` alias; set a model supported by your account if needed. Increase `TURN_TIMEOUT_MS` for longer real requests. Never commit a key.

The real adapter uses Anthropic's Agent SDK with session resume between successful turns in a chat, a four-turn limit, a $0.10 SDK budget per query, and denied tool permissions. Docker gives it a separate writable working directory. This tracing fixture does not enable upstream Bash/file/web tools. The `agent.claude` span measures the whole SDK turn, **not** individual HTTP requests, tokens, or subprocess internals. Mock mode cannot verify model authentication, billing, SDK subprocess behavior, or real session resumption. Those need a separate credentialed smoke test.

## Tracepath integration handoff

**Importing this fork does not yet enable Tracepath Live mode.** Integration is intentionally left for the main Tracepath task:

1. Accept bounded generic JSON bodies (`payloadKind: "json"`) instead of only order/payment bodies. The root `tracepath.runtime.json` uses this proposed extension; the current validator rejects it.
2. Register this repo and a pinned commit as a trusted runner. Start/stop this Compose project and read its span feed, never arbitrary manifest commands.
3. Match operation IDs to the indexed source functions at exactly the recording revision. The manifest paths include `simple-chatapp/` because the imported repo is the entire upstream fork.
4. Use the existing graph canvas. Preserve each concurrent request's identity and distinguish `agent.mock` from actual `agent.claude` evidence.
5. Initial presets cover the four routes needing no path parameters: health, list/create chats, and the turn adapter. The three `:id` routes are instrumented and tested but need path-parameter substitution before adding runnable UI presets. WebSocket turns are measured by the same operation but require an explicit transport adapter if driven directly by Tracepath.

The seven root-manifest scenarios include success, failure, timeout, concurrency, chat creation/listing, and health. Failure/timeout presets are for mock mode only; choose the ordinary success payload for a credentialed smoke test.

## Validation and upstream changes

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm run demo:verify  # Docker environment must already be running
```

The integration test starts an isolated local server in mock mode. It verifies HTTP/WebSocket execution, source revision and parent spans, concurrent requests, running-span visibility, same-chat exclusion, errors, timeout cancellation, CRUD behavior, and protected trace retrieval. Tests do not contact Claude.

Upstream's lockfile referenced an internal registry. This fork regenerates it against public npm, pins dependencies, updates affected dependencies, and replaces UUID generation with Node's built-in UUID function. The frontend uses a same-origin WebSocket URL so Vite proxying and Docker both work. Vite's production bundle is served by Express. The mode banner and error display make runtime behavior visible.

Chat data, session IDs, and spans are in memory and disappear on restart. This remains a local demo without user authentication or production persistence. The HTTP turn adapter returns a completed turn rather than SSE/token streaming. The mock is an echo fixture, not a language model. Historical upstream agent behavior is narrowed deliberately to make this small tracing demo predictable.
