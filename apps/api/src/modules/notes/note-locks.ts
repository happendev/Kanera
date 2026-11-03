import type { WireNoteLock } from "@kanera/shared/events";
import { notes, users, type Note } from "@kanera/shared/schema";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { AppError } from "../../lib/errors.js";
import { signedAvatarUrl } from "../../lib/media-keys.js";
import { emitNoteEvent } from "./route-support.js";

const LOCK_TTL_MS = 90_000; // 90 seconds

export function isLockedByOther(note: Pick<Note, "editingUserId" | "editingExpiresAt">, userId: string): boolean {
  if (!note.editingUserId || note.editingUserId === userId) return false;
  if (!note.editingExpiresAt) return false;
  return note.editingExpiresAt.getTime() > Date.now();
}

export function isLockHeldBy(note: Pick<Note, "editingUserId" | "editingExpiresAt">, userId: string): boolean {
  if (note.editingUserId !== userId || !note.editingExpiresAt) return false;
  return note.editingExpiresAt.getTime() > Date.now();
}

async function buildNoteLockForUser(
  noteId: string,
  editingUserId: string,
  editingExpiresAt: Date,
): Promise<WireNoteLock> {
  const [user] = await db
    .select({ displayName: users.displayName, avatarUrl: users.avatarUrl, clientId: users.clientId })
    .from(users)
    .where(eq(users.id, editingUserId))
    .limit(1);
  return {
    noteId,
    editingUserId,
    editingUserName: user?.displayName ?? "Someone",
    editingUserAvatarUrl: user ? signedAvatarUrl(user.clientId, user.avatarUrl) : null,
    editingExpiresAt: editingExpiresAt.toISOString(),
  };
}

export async function buildNoteLock(note: Pick<Note, "id" | "editingUserId" | "editingExpiresAt">): Promise<WireNoteLock> {
  if (!note.editingUserId || !note.editingExpiresAt) throw new Error("cannot build lock payload without lock");
  return buildNoteLockForUser(note.id, note.editingUserId, note.editingExpiresAt);
}

/**
 * Takes or renews the caller's edit lock on a team note and emits `note:locked`. Personal notes are
 * never contended, so they answer with a synthetic lock and touch nothing.
 */
export async function lockNote({ auth, note }: { auth: AuthClaims; note: Note }): Promise<WireNoteLock> {
  const id = note.id;
  if (note.scope === "personal") {
    const expiresAt = new Date(Date.now() + LOCK_TTL_MS);
    return buildNoteLockForUser(id, auth.sub, expiresAt);
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);
  const [updated] = await db
    .update(notes)
    .set({ editingUserId: auth.sub, editingExpiresAt: expiresAt })
    .where(
      and(
        eq(notes.id, id),
        or(
          isNull(notes.editingUserId),
          eq(notes.editingUserId, auth.sub),
          lt(notes.editingExpiresAt, now),
        ),
      ),
    )
    .returning();
  if (!updated) {
    throw new AppError(409, "NOTE_LOCKED", "note is being edited by another user", {
      lock: await buildNoteLock(note),
    });
  }
  emitNoteEvent(updated, "note:locked", {
    ...(await buildNoteLock(updated)),
  });
  return buildNoteLock(updated);
}

/** Releases the caller's edit lock on a team note; personal notes and locks held by others are left alone. */
export async function unlockNote({ auth, note }: { auth: AuthClaims; note: Note }): Promise<void> {
  const id = note.id;
  if (note.scope === "personal") return;
  const [updated] = await db
    .update(notes)
    .set({ editingUserId: null, editingExpiresAt: null })
    .where(and(eq(notes.id, id), eq(notes.editingUserId, auth.sub)))
    .returning();
  if (updated) emitNoteEvent(updated, "note:unlocked", { noteId: id });
}
