import type { FastifyBaseLogger } from "fastify";
import type { ServerToClientEvents } from "@kanera/shared/events";
import { env } from "../env.js";

export type RealtimeEmitScope = "board" | "workspace" | "user" | "client";
let realtimeLog: FastifyBaseLogger | undefined;

interface RealtimeEmitMetricInput<E extends keyof ServerToClientEvents> {
  log?: FastifyBaseLogger;
  scope: RealtimeEmitScope;
  targetId: string;
  event: E;
  payload: Parameters<ServerToClientEvents[E]>[0];
  durationMs: number;
  roomSize?: () => number | undefined;
}

function shouldSampleRealtimeEmit(): boolean {
  if (!env.REALTIME_EMIT_METRICS_ENABLED) return false;
  if (env.REALTIME_EMIT_METRICS_SAMPLE_RATE >= 1) return true;
  if (env.REALTIME_EMIT_METRICS_SAMPLE_RATE <= 0) return false;
  return Math.random() < env.REALTIME_EMIT_METRICS_SAMPLE_RATE;
}

function estimatePayloadBytes(payload: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(payload));
  } catch {
    return 0;
  }
}

export function logRealtimeEmit<E extends keyof ServerToClientEvents>({
  log,
  scope,
  targetId,
  event,
  payload,
  durationMs,
  roomSize,
}: RealtimeEmitMetricInput<E>): void {
  if (!shouldSampleRealtimeEmit()) return;
  const payloadBytes = estimatePayloadBytes(payload);
  if (payloadBytes < env.REALTIME_EMIT_METRICS_MIN_BYTES) return;

  const metric = {
    scope,
    targetId,
    event,
    payloadBytes,
    compressionEligible: env.REALTIME_WEBSOCKET_COMPRESSION_ENABLED
      && payloadBytes >= env.REALTIME_WEBSOCKET_COMPRESSION_THRESHOLD_BYTES,
    durationMs: Math.round(durationMs * 100) / 100,
    roomSize: roomSize?.(),
  };
  const targetLog = log ?? realtimeLog;
  if (targetLog) {
    targetLog.info(metric, "realtime emit");
    return;
  }
  console.info(JSON.stringify({ level: "info", msg: "realtime emit", ...metric }));
}

export function logRealtimePublishFailure<E extends keyof ServerToClientEvents>(
  err: unknown,
  input: {
    scope: RealtimeEmitScope;
    scopeId: string;
    event: E;
  },
): void {
  const details = {
    err,
    scope: input.scope,
    scopeId: input.scopeId,
    event: input.event,
  };
  if (realtimeLog) {
    realtimeLog.error(details, "failed to publish realtime outbox event");
    return;
  }
  console.error(JSON.stringify({ level: "error", msg: "failed to publish realtime outbox event", ...details }));
}

export function setRealtimeLogger(log: FastifyBaseLogger): void {
  realtimeLog = log;
}

export function setRealtimeMetricsLogger(log: FastifyBaseLogger): void {
  setRealtimeLogger(log);
}
