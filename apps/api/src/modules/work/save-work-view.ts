import type { dto } from "@kanera/shared";
import type { SavedWorkView } from "@kanera/shared/dto";
import { clientMembers, users, workViewShares, workViews } from "@kanera/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { loadAccessibleBoards } from "../../lib/accessible-boards.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { shapeSavedViews } from "./saved-views.js";

/** A saved view the caller may administer: it must exist and be their own in their organisation. */
async function loadOwnedWorkView(auth: AuthClaims, id: string) {
  const [current] = await db.select().from(workViews).where(eq(workViews.id, id)).limit(1);
  if (!current) throw notFound("work view not found");
  if (current.ownerId !== auth.sub || current.clientId !== auth.cid) throw forbidden();
  return current;
}

/** The written row as the client sees it: with its owner's name and sanitized definition. */
async function shapeOwnView(auth: AuthClaims, row: typeof workViews.$inferSelect): Promise<SavedWorkView> {
  const [owner, accessibleBoards] = await Promise.all([
    db.select({ displayName: users.displayName }).from(users).where(eq(users.id, auth.sub)).limit(1),
    loadAccessibleBoards(auth),
  ]);
  const [shaped] = await shapeSavedViews([{ ...row, ownerName: owner[0]?.displayName ?? "Unknown" }], auth.sub, accessibleBoards);
  return shaped!;
}

export async function createWorkView({ auth, body }: { auth: AuthClaims; body: dto.CreateWorkViewBody }): Promise<SavedWorkView> {
  const [row] = await db
    .insert(workViews)
    .values({
      clientId: auth.cid,
      ownerId: auth.sub,
      name: body.name,
      lens: body.lens,
      visibility: body.visibility,
      definition: body.definition,
    })
    .returning();
  return shapeOwnView(auth, row!);
}

export async function updateWorkView({ auth, id, body }: { auth: AuthClaims; id: string; body: dto.UpdateWorkViewBody }): Promise<SavedWorkView> {
  await loadOwnedWorkView(auth, id);
  const [row] = await db
    .update(workViews)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.lens !== undefined ? { lens: body.lens } : {}),
      ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
      ...(body.definition !== undefined ? { definition: body.definition } : {}),
      updatedAt: new Date(),
    })
    .where(eq(workViews.id, id))
    .returning();
  return shapeOwnView(auth, row!);
}

export async function deleteWorkView({ auth, id }: { auth: AuthClaims; id: string }): Promise<void> {
  await loadOwnedWorkView(auth, id);
  await db.delete(workViews).where(eq(workViews.id, id));
}

export async function shareWorkView({ auth, id, userId }: { auth: AuthClaims; id: string; userId: string }): Promise<void> {
  const current = await loadOwnedWorkView(auth, id);
  const [target] = await db
    .select({ id: users.id })
    .from(clientMembers)
    .innerJoin(users, eq(users.id, clientMembers.userId))
    .where(and(
      eq(clientMembers.userId, userId),
      eq(clientMembers.clientId, auth.cid),
      isNull(clientMembers.removedAt),
      isNull(clientMembers.suspendedAt),
      isNull(users.deletedAt),
    ))
    .limit(1);
  if (!target) throw badRequest("share target must be an active user in your organisation");
  if (target.id === current.ownerId) throw badRequest("the owner already has access");
  await db.insert(workViewShares).values({ viewId: id, userId }).onConflictDoNothing();
}

export async function unshareWorkView({ auth, id, userId }: { auth: AuthClaims; id: string; userId: string }): Promise<void> {
  await loadOwnedWorkView(auth, id);
  await db.delete(workViewShares).where(and(eq(workViewShares.viewId, id), eq(workViewShares.userId, userId)));
}
