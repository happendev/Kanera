import { users, workspaces } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { env } from "../env.js";

export interface UserDisplayMetadata {
  displayName: string;
  avatarUrl: string | null;
  clientId: string;
}

const userDisplayCache = new Map<string, { metadata: UserDisplayMetadata; expiresAt: number }>();

function cacheKey(workspaceId: string, userId: string): string {
  return `${workspaceId}:${userId}`;
}

export function getCachedUserDisplay(workspaceId: string, userId: string): UserDisplayMetadata | null {
  if (env.USER_DISPLAY_CACHE_TTL_MS === 0) return null;
  const key = cacheKey(workspaceId, userId);
  const cached = userDisplayCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    userDisplayCache.delete(key);
    return null;
  }
  return cached.metadata;
}

export function setCachedUserDisplay(workspaceId: string, userId: string, metadata: UserDisplayMetadata): void {
  if (env.USER_DISPLAY_CACHE_TTL_MS === 0) return;
  userDisplayCache.set(cacheKey(workspaceId, userId), {
    metadata,
    expiresAt: Date.now() + env.USER_DISPLAY_CACHE_TTL_MS,
  });
}

export async function getUserDisplay(workspaceId: string, userId: string): Promise<UserDisplayMetadata | null> {
  const cached = getCachedUserDisplay(workspaceId, userId);
  if (cached) return cached;

  const [metadata] = await db
    .select({ displayName: users.displayName, avatarUrl: users.avatarUrl, clientId: workspaces.clientId })
    .from(users)
    .innerJoin(workspaces, eq(workspaces.id, workspaceId))
    .where(eq(users.id, userId))
    .limit(1);

  if (metadata) setCachedUserDisplay(workspaceId, userId, metadata);
  return metadata ?? null;
}
