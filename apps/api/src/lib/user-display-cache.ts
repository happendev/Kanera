import { users, workspaces } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { env } from "../env.js";
import { ExpiringCache } from "./expiring-cache.js";

export interface UserDisplayMetadata {
  displayName: string;
  avatarUrl: string | null;
  clientId: string;
}

const userDisplayCache = new ExpiringCache<UserDisplayMetadata>(10_000);

function cacheKey(workspaceId: string, userId: string): string {
  return `${workspaceId}:${userId}`;
}

export function getCachedUserDisplay(workspaceId: string, userId: string): UserDisplayMetadata | null {
  if (env.USER_DISPLAY_CACHE_TTL_MS === 0) return null;
  return userDisplayCache.get(cacheKey(workspaceId, userId)) ?? null;
}

export function setCachedUserDisplay(workspaceId: string, userId: string, metadata: UserDisplayMetadata): void {
  if (env.USER_DISPLAY_CACHE_TTL_MS === 0) return;
  userDisplayCache.set(cacheKey(workspaceId, userId), metadata, Date.now() + env.USER_DISPLAY_CACHE_TTL_MS);
}

export async function getUserDisplay(workspaceId: string, userId: string): Promise<UserDisplayMetadata | null> {
  const cached = getCachedUserDisplay(workspaceId, userId);
  if (cached) return cached;

  const [metadata] = await db
    // Profile media belongs to the user, including cross-organisation board
    // guests; the workspace client id would produce an invalid avatar signature.
    .select({ displayName: users.displayName, avatarUrl: users.avatarUrl, clientId: users.clientId })
    .from(users)
    .innerJoin(workspaces, eq(workspaces.id, workspaceId))
    .where(eq(users.id, userId))
    .limit(1);

  if (metadata) setCachedUserDisplay(workspaceId, userId, metadata);
  return metadata ?? null;
}
