import type { FastifyBaseLogger } from "fastify";
import { randomUUID } from "node:crypto";
import type { ServerToClientEvents } from "@kanera/shared/events";
import { getRedis, type RedisClient } from "../redis.js";

type PresenceEvent = Parameters<ServerToClientEvents["presence:changed"]>[0];

const HEARTBEAT_TTL_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const REAPER_INTERVAL_MS = 5_000;

const MARK_ONLINE_SCRIPT = `
local hashKey = KEYS[1]
local serverSocketsKey = KEYS[2]
local socketId = ARGV[1]
local userId = ARGV[2]
local entry = ARGV[3]

local values = redis.call("HVALS", hashKey)
local wasOffline = 1
for _, value in ipairs(values) do
  if value == userId then
    wasOffline = 0
    break
  end
end

redis.call("HSET", hashKey, socketId, userId)
redis.call("SADD", serverSocketsKey, entry)
return wasOffline
`;

const MARK_OFFLINE_SCRIPT = `
local hashKey = KEYS[1]
local serverSocketsKey = KEYS[2]
local socketId = ARGV[1]
local userId = ARGV[2]
local entry = ARGV[3]

if redis.call("HGET", hashKey, socketId) ~= userId then
  redis.call("SREM", serverSocketsKey, entry)
  return 0
end

redis.call("HDEL", hashKey, socketId)
redis.call("SREM", serverSocketsKey, entry)

local values = redis.call("HVALS", hashKey)
for _, value in ipairs(values) do
  if value == userId then
    return 0
  end
end
return 1
`;

function workspacePresenceKey(workspaceId: string): string {
  return `presence:ws:${workspaceId}`;
}

function serverSocketsKey(serverId: string): string {
  return `presence:server:${serverId}:sockets`;
}

function serverAliveKey(serverId: string): string {
  return `presence:alive:${serverId}`;
}

function socketEntry(workspaceId: string, socketId: string, userId: string): string {
  return JSON.stringify({ workspaceId, socketId, userId });
}

function parseSocketEntry(value: string): { workspaceId: string; socketId: string; userId: string } | null {
  try {
    const parsed = JSON.parse(value) as { workspaceId?: unknown; socketId?: unknown; userId?: unknown };
    if (typeof parsed.workspaceId !== "string" || typeof parsed.socketId !== "string" || typeof parsed.userId !== "string") return null;
    return { workspaceId: parsed.workspaceId, socketId: parsed.socketId, userId: parsed.userId };
  } catch {
    return null;
  }
}

export class PresenceTracker {
  private readonly redis: RedisClient;
  private readonly serverId: string;
  private readonly workspacesBySocket = new Map<string, Set<string>>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: { redis?: RedisClient; serverId?: string } = {}) {
    this.redis = options.redis ?? getRedis();
    this.serverId = options.serverId ?? randomUUID();
  }

  async startHeartbeat(): Promise<void> {
    await this.writeHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.writeHeartbeat().catch(() => undefined);
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  async close(): Promise<PresenceEvent[]> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const events: PresenceEvent[] = [];
    const entries = await this.redis.smembers(serverSocketsKey(this.serverId));
    for (const rawEntry of entries) {
      const entry = parseSocketEntry(rawEntry);
      if (!entry) continue;
      const crossedOffline = await this.markOfflineInRedis(entry.workspaceId, entry.userId, entry.socketId, this.serverId);
      if (crossedOffline) events.push({ workspaceId: entry.workspaceId, userId: entry.userId, online: false });
    }
    await Promise.allSettled([
      this.redis.del(serverAliveKey(this.serverId)),
      this.redis.srem("presence:servers", this.serverId),
      this.redis.del(serverSocketsKey(this.serverId)),
    ]);
    this.workspacesBySocket.clear();
    return events;
  }

  async markOnline(workspaceId: string, userId: string, socketId: string): Promise<PresenceEvent | null> {
    const entry = socketEntry(workspaceId, socketId, userId);
    const crossedOnline = await this.redis.eval(
      MARK_ONLINE_SCRIPT,
      2,
      workspacePresenceKey(workspaceId),
      serverSocketsKey(this.serverId),
      socketId,
      userId,
      entry,
    );
    await this.redis.sadd("presence:servers", this.serverId);

    const workspaces = this.workspacesBySocket.get(socketId) ?? new Set<string>();
    workspaces.add(workspaceId);
    this.workspacesBySocket.set(socketId, workspaces);

    return Number(crossedOnline) === 1 ? { workspaceId, userId, online: true } : null;
  }

  async markOffline(workspaceId: string, userId: string, socketId: string): Promise<PresenceEvent | null> {
    const crossedOffline = await this.markOfflineInRedis(workspaceId, userId, socketId, this.serverId);
    const workspaces = this.workspacesBySocket.get(socketId);
    workspaces?.delete(workspaceId);
    if (workspaces?.size === 0) this.workspacesBySocket.delete(socketId);
    return crossedOffline ? { workspaceId, userId, online: false } : null;
  }

  async removeSocket(socketId: string, userId: string): Promise<PresenceEvent[]> {
    const workspaces = this.workspacesBySocket.get(socketId);
    if (!workspaces) return [];
    this.workspacesBySocket.delete(socketId);

    const events: PresenceEvent[] = [];
    for (const workspaceId of workspaces) {
      const crossedOffline = await this.markOfflineInRedis(workspaceId, userId, socketId, this.serverId);
      if (crossedOffline) events.push({ workspaceId, userId, online: false });
    }
    return events;
  }

  async onlineUserIds(workspaceId: string): Promise<string[]> {
    const userIds = await this.redis.hvals(workspacePresenceKey(workspaceId)) as string[];
    return [...new Set(userIds)];
  }

  private async writeHeartbeat(): Promise<void> {
    await Promise.all([
      this.redis.set(serverAliveKey(this.serverId), "1", "PX", HEARTBEAT_TTL_MS),
      this.redis.sadd("presence:servers", this.serverId),
    ]);
  }

  private async markOfflineInRedis(workspaceId: string, userId: string, socketId: string, serverId: string): Promise<boolean> {
    const entry = socketEntry(workspaceId, socketId, userId);
    const crossedOffline = await this.redis.eval(
      MARK_OFFLINE_SCRIPT,
      2,
      workspacePresenceKey(workspaceId),
      serverSocketsKey(serverId),
      socketId,
      userId,
      entry,
    );
    return Number(crossedOffline) === 1;
  }
}

export function startPresenceReaper(options: {
  emit: (event: PresenceEvent) => void;
  log?: FastifyBaseLogger;
  intervalMs?: number;
}): () => void {
  const redis = getRedis();
  const intervalMs = options.intervalMs ?? REAPER_INTERVAL_MS;
  let running = false;

  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const serverIds = await redis.smembers("presence:servers");
      for (const serverId of serverIds) {
        if (await redis.exists(serverAliveKey(serverId))) continue;

        // Only the worker reaps dead process socket entries. That keeps normal disconnects cheap
        // while still correcting presence after a crashed API process can no longer emit offline.
        const entries = await redis.smembers(serverSocketsKey(serverId));
        for (const rawEntry of entries) {
          const entry = parseSocketEntry(rawEntry);
          if (!entry) {
            await redis.srem(serverSocketsKey(serverId), rawEntry);
            continue;
          }
          const crossedOffline = await redis.eval(
            MARK_OFFLINE_SCRIPT,
            2,
            workspacePresenceKey(entry.workspaceId),
            serverSocketsKey(serverId),
            entry.socketId,
            entry.userId,
            rawEntry,
          );
          if (Number(crossedOffline) === 1) {
            options.emit({ workspaceId: entry.workspaceId, userId: entry.userId, online: false });
          }
        }
        await Promise.all([
          redis.del(serverSocketsKey(serverId)),
          redis.srem("presence:servers", serverId),
        ]);
      }
    } catch (err) {
      options.log?.warn({ err }, "presence reaper failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref();
  void sweep();
  return () => clearInterval(timer);
}
