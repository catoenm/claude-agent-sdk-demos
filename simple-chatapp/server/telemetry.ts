import { randomUUID } from "node:crypto";
import {
  context,
  propagation,
  ROOT_CONTEXT,
  trace,
  SpanStatusCode,
} from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type {
  ReadableSpan,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
export interface ObservedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operation: string;
  runId: string;
  requestId: string;
  revision: string;
  service: string;
  startMs: number;
  endMs?: number;
  durationMs?: number;
  error?: boolean;
  message?: string;
}
const records = new Map<string, ObservedSpan>();
const milliseconds = ([seconds, nanos]: readonly number[]) =>
  seconds * 1000 + nanos / 1e6;
function record(span: ReadableSpan, ended: boolean) {
  const data: ObservedSpan = {
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    operation: String(span.attributes["tracepath.operation"]),
    runId: String(span.attributes["tracepath.run"]),
    requestId: String(span.attributes["tracepath.request"]),
    revision: process.env.TRACEPATH_REVISION ?? "unversioned",
    service: "chat-api",
    startMs: milliseconds(span.startTime),
    ...(ended
      ? {
          endMs: milliseconds(span.endTime),
          durationMs: milliseconds(span.duration),
          error: span.status.code === SpanStatusCode.ERROR,
          message: span.status.message,
        }
      : {}),
  };
  records.set(data.spanId, data);
  while (records.size > 5000) records.delete(records.keys().next().value!);
}
const processor: SpanProcessor = {
  onStart: (span) => record(span, false),
  onEnd: (span) => record(span, true),
  forceFlush: async () => {},
  shutdown: async () => {},
};
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ "service.name": "chat-api" }),
  spanProcessors: [processor],
});
provider.register();
const tracer = trace.getTracer("tracepath-chat-demo");
export function operation<T>(
  id: string,
  work: () => T | Promise<T>,
): Promise<T> {
  const baggage = propagation.getBaggage(context.active());
  return tracer.startActiveSpan(
    id,
    {
      attributes: {
        "tracepath.operation": id,
        "tracepath.run": baggage?.getEntry("run")?.value ?? "",
        "tracepath.request": baggage?.getEntry("request")?.value ?? "",
      },
    },
    async (span) => {
      try {
        return await work();
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
export function requestContext<T>(
  headers: Record<string, unknown>,
  work: (ids: { runId: string; requestId: string }) => T,
): T {
  const supplied = headers["x-tracepath-run"];
  const runId =
    typeof supplied === "string" && /^[a-f0-9-]{36}$/i.test(supplied)
      ? supplied
      : randomUUID();
  const requestId =
    typeof headers["x-tracepath-request"] === "string"
      ? headers["x-tracepath-request"].slice(0, 100)
      : randomUUID();
  const extracted = propagation.extract(ROOT_CONTEXT, headers);
  const baggage = propagation.createBaggage({
    run: { value: runId },
    request: { value: requestId },
  });
  return context.with(propagation.setBaggage(extracted, baggage), () =>
    work({ runId, requestId }),
  );
}
export function getSpans(runId: string) {
  return [...records.values()].filter((span) => span.runId === runId);
}
