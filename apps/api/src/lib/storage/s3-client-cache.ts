import { S3Client } from "@aws-sdk/client-s3";
import type { StorageConfig } from "@kanera/shared/schema";
import { createHash } from "node:crypto";

type S3Config = Extract<StorageConfig, { kind: "s3" }>;
const MAX_IDLE_CLIENTS = 32;
const IDLE_TTL_MS = 60_000;
interface ClientEntry {
  client: S3Client;
  users: number;
  idleAt: number;
}

const clients = new Map<string, ClientEntry>();
let cleanupTimer: ReturnType<typeof setTimeout> | undefined;

function pruneIdleClients(): void {
  const now = Date.now();
  const idle = [...clients].filter(([, entry]) => entry.users === 0);
  let remaining = idle.length;
  for (const [key, entry] of idle) {
    if (remaining > MAX_IDLE_CLIENTS || now - entry.idleAt >= IDLE_TTL_MS) {
      clients.delete(key);
      entry.client.destroy();
      remaining -= 1;
    }
  }
  if (!cleanupTimer && remaining > 0) {
    cleanupTimer = setTimeout(() => {
      cleanupTimer = undefined;
      pruneIdleClients();
    }, IDLE_TTL_MS);
    cleanupTimer.unref();
  }
}

/** Reuse connections without caching tenant config or interrupting an active upload/download. */
export function acquireS3Client(config: S3Config): { client: S3Client; release: () => void } {
  // Config is re-read by getStorageForClient on every request. A changed endpoint, region or
  // credential must immediately select a different client; never key this cache by tenant alone.
  // Bucket and tenant prefixes stay on each command, so shared credentials can safely reuse a pool.
  const key = createHash("sha256").update(JSON.stringify([
    config.region, config.endpoint ?? null, config.accessKeyId, config.secretAccessKey,
  ])).digest("hex");
  let entry = clients.get(key);
  if (entry?.users === 0 && Date.now() - entry.idleAt >= IDLE_TTL_MS) {
    clients.delete(key);
    entry.client.destroy();
    entry = undefined;
  }
  if (!entry) {
    entry = {
      client: new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        forcePathStyle: !!config.endpoint,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      }),
      users: 0,
      idleAt: 0,
    };
  }
  const acquired = entry;
  clients.delete(key);
  clients.set(key, acquired);
  acquired.users += 1;
  pruneIdleClients();
  let released = false;
  return {
    client: acquired.client,
    release: () => {
      if (released) return;
      released = true;
      acquired.users -= 1;
      acquired.idleAt = Date.now();
      // LRU order follows completion too: a long download must not look oldest when it goes idle.
      clients.delete(key);
      clients.set(key, acquired);
      pruneIdleClients();
    },
  };
}
