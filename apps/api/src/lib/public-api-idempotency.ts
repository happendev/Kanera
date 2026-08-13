import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { badRequest, conflict } from "./errors.js";
import { getRedis, type RedisClient } from "../redis.js";

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

interface PendingRecord {
  state: "pending";
  fingerprint: string;
  owner: string;
}

interface CompleteRecord {
  state: "complete";
  fingerprint: string;
  statusCode: number;
  contentType?: string;
  location?: string;
  body: string;
}

type IdempotencyRecord = PendingRecord | CompleteRecord;

interface OwnedRequest {
  redisKey: string;
  fingerprint: string;
  owner: string;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function requestFingerprint(req: FastifyRequest): string {
  return createHash("sha256")
    .update(req.method)
    .update("\0")
    .update(req.url)
    .update("\0")
    .update(stableJson(req.body))
    .digest("hex");
}

function storageKey(req: FastifyRequest, idempotencyKey: string): string {
  // Keys are identity-scoped so one user's retry token cannot reveal or replay another user's response.
  const principal = `${req.auth.cid}:${req.auth.apiKeyId ?? req.auth.sub}`;
  const digest = createHash("sha256").update(principal).update("\0").update(idempotencyKey).digest("hex");
  return `public-api:idempotency:${digest}`;
}

function parseRecord(value: string | null): IdempotencyRecord | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<IdempotencyRecord>;
    if (parsed.state !== "pending" && parsed.state !== "complete") return null;
    return parsed as IdempotencyRecord;
  } catch {
    return null;
  }
}

function replay(reply: FastifyReply, record: CompleteRecord) {
  reply.header("Idempotency-Replayed", "true");
  if (record.contentType) reply.header("Content-Type", record.contentType);
  if (record.location) reply.header("Location", record.location);
  return reply.status(record.statusCode).send(record.body);
}

export function registerPublicApiIdempotency(app: FastifyInstance, options: { redis?: RedisClient } = {}) {
  const redis = options.redis ?? getRedis();
  const ownedRequests = new WeakMap<FastifyRequest, OwnedRequest>();

  app.addHook("preHandler", async (req, reply) => {
    if (!MUTATION_METHODS.has(req.method) || req.headers["content-type"]?.toLowerCase().startsWith("multipart/form-data")) return;
    const header = req.headers["idempotency-key"];
    if (header === undefined) return;
    if (typeof header !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(header)) {
      throw badRequest("Idempotency-Key must contain 1 to 255 visible ASCII characters");
    }

    const fingerprint = requestFingerprint(req);
    const redisKey = storageKey(req, header);
    const owner = randomUUID();
    const pending: PendingRecord = { state: "pending", fingerprint, owner };
    const claimed = await redis.set(redisKey, JSON.stringify(pending), "EX", IDEMPOTENCY_TTL_SECONDS, "NX");
    if (claimed === "OK") {
      ownedRequests.set(req, { redisKey, fingerprint, owner });
      return;
    }

    const existing = parseRecord(await redis.get(redisKey));
    if (!existing) {
      // An expired or malformed entry is safe to retry as a fresh request.
      const reclaimed = await redis.set(redisKey, JSON.stringify(pending), "EX", IDEMPOTENCY_TTL_SECONDS, "NX");
      if (reclaimed === "OK") {
        ownedRequests.set(req, { redisKey, fingerprint, owner });
        return;
      }
      throw conflict("an idempotent request with this key is already in progress");
    }
    if (existing.fingerprint !== fingerprint) {
      throw conflict("Idempotency-Key was already used for a different request");
    }
    if (existing.state === "pending") {
      throw conflict("an idempotent request with this key is already in progress");
    }
    return replay(reply, existing);
  });

  app.addHook("onSend", async (req, reply, payload) => {
    const owned = ownedRequests.get(req);
    if (!owned) return payload;

    const current = parseRecord(await redis.get(owned.redisKey));
    if (current?.state !== "pending" || current.owner !== owned.owner) return payload;
    if (reply.statusCode >= 500) {
      // Server failures are safe to retry; do not pin a transient failure to the key for 24 hours.
      await redis.del(owned.redisKey);
      return payload;
    }

    const contentType = reply.getHeader("content-type")?.toString();
    const location = reply.getHeader("location")?.toString();
    const complete: CompleteRecord = {
      state: "complete",
      fingerprint: owned.fingerprint,
      statusCode: reply.statusCode,
      ...(contentType ? { contentType } : {}),
      ...(location ? { location } : {}),
      body: typeof payload === "string" ? payload : payload?.toString() ?? "",
    };
    await redis.set(owned.redisKey, JSON.stringify(complete), "EX", IDEMPOTENCY_TTL_SECONDS);
    return payload;
  });
}
