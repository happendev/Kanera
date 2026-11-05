import { Redis, type RedisOptions } from "ioredis";
import { env } from "./env.js";

// ioredis is the Redis-protocol client used against the required Valkey service.
export type RedisClient = Redis;

const RETRY_MAX_DELAY_MS = 2_000;
const STARTUP_PING_TIMEOUT_MS = 5_000;
// With maxRetriesPerRequest: null, commands queue indefinitely during an outage. A command timeout
// bounds that so callers on the request hot path (rate limiting) fail fast and can fail open instead
// of hanging until Valkey returns. Sized well above a healthy round-trip to avoid false timeouts.
const COMMAND_TIMEOUT_MS = 2_000;
const ERROR_LOG_THROTTLE_MS = 30_000;

let redis: RedisClient | null = null;
let lastErrorLoggedAt = 0;

// ioredis emits an "error" event on every reconnect attempt, so an outage would otherwise spam the
// logs. Throttle to one line per window so a runtime Valkey problem is visible without drowning logs.
function logRedisError(scope: string, error: unknown): void {
  const now = Date.now();
  if (now - lastErrorLoggedAt < ERROR_LOG_THROTTLE_MS) return;
  lastErrorLoggedAt = now;
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[valkey] ${scope} connection error (throttled ${ERROR_LOG_THROTTLE_MS}ms): ${message}`);
}

async function createClient(): Promise<RedisClient> {
  const options: RedisOptions = {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectTimeout: 1_000,
    commandTimeout: COMMAND_TIMEOUT_MS,
    retryStrategy: (times) => Math.min(times * 100, RETRY_MAX_DELAY_MS),
  };

  if (env.NODE_ENV === "test") {
    const { default: RedisMock } = await import("ioredis-mock");
    return new RedisMock(env.REDIS_URL, options) as unknown as RedisClient;
  }

  return new Redis(env.REDIS_URL, options);
}

function valkeyUnavailableError(): Error {
  return new Error(
    `Valkey is unavailable at REDIS_URL=${env.REDIS_URL}. Start it with "pnpm dev:db" for local development.`,
  );
}

async function waitForStartupPing(client: RedisClient): Promise<void> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      client.ping(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(valkeyUnavailableError()), STARTUP_PING_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Valkey is unavailable")) throw error;
    throw valkeyUnavailableError();
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function initRedis(): Promise<RedisClient> {
  if (redis) return redis;
  redis = await createClient();
  // ioredis emits connection failures as "error" events while retrying. The startup ping below
  // turns an unavailable Valkey service into one actionable boot error; throttled logging keeps a
  // later runtime outage visible without one log line per reconnect attempt.
  redis.on("error", (err) => logRedisError("client", err));
  try {
    await waitForStartupPing(redis);
  } catch (error) {
    redis.disconnect();
    redis = null;
    throw error;
  }
  return redis;
}

export function getRedis(): RedisClient {
  if (!redis) throw new Error("Valkey client not initialised");
  return redis;
}

export async function closeRedis(): Promise<void> {
  if (!redis) return;
  const client = redis;
  redis = null;
  await closeClient(client);
}

async function closeClient(client: RedisClient): Promise<void> {
  // QUIT cannot succeed while reconnecting. Never wait for a dependency to come back during exit.
  if (client.status !== "ready") {
    client.disconnect();
    return;
  }
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.quit(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Valkey shutdown timed out")), COMMAND_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    logRedisError("shutdown", error);
  } finally {
    clearTimeout(timeout);
    client.disconnect();
  }
}

function observeAdapterErrors(client: RedisClient): void {
  // ioredis-mock implements pub/sub directly and has no low-level sendCommand to observe.
  if (typeof client.sendCommand !== "function") return;
  const sendCommand = client.sendCommand.bind(client);
  client.sendCommand = (...args) => {
    const result = sendCommand(...args);
    // redis-adapter fires publish/(un)subscribe commands without awaiting their promises.
    // A lost connection during teardown rejects those commands even with an error-event listener.
    // Observe the rejection without changing the promise seen by callers that do await it.
    void Promise.resolve(result).catch((error: unknown) => logRedisError("adapter command", error));
    return result;
  };
}

export async function createAdapterPair(): Promise<{ pubClient: RedisClient; subClient: RedisClient; close: () => Promise<void> }> {
  // The adapter's subscriber is a long-lived pub/sub connection, so the request-path command timeout
  // does not apply here; clear it on the duplicates to avoid interfering with subscription delivery.
  const pubClient = getRedis().duplicate({ commandTimeout: undefined });
  const subClient = getRedis().duplicate({ commandTimeout: undefined });
  observeAdapterErrors(pubClient);
  observeAdapterErrors(subClient);
  pubClient.setMaxListeners(0);
  subClient.setMaxListeners(0);
  pubClient.on("error", (err) => logRedisError("adapter pub", err));
  subClient.on("error", (err) => logRedisError("adapter sub", err));
  await Promise.all([pubClient.ping(), subClient.ping()]);
  return {
    pubClient,
    subClient,
    close: async () => {
      await Promise.all([closeClient(pubClient), closeClient(subClient)]);
    },
  };
}
