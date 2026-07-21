import { boardMembers, boards, clientGuestSeats, users, workspaces } from "@kanera/shared/schema";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db, type Db } from "../db.js";
import { env } from "../env.js";
import { assertSeatPoolAvailable } from "./tier-limits.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

async function guestBoardIds(params: {
  hostClientId: string;
  userId: string;
  includeBoardId?: string;
  includeBoardIds?: string[];
  tx?: Tx;
}): Promise<Set<string>> {
  const database = params.tx ?? db;
  const rows = await database
    .select({ boardId: boardMembers.boardId })
    .from(boardMembers)
    .innerJoin(boards, eq(boards.id, boardMembers.boardId))
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .innerJoin(users, eq(users.id, boardMembers.userId))
    .where(and(
      eq(workspaces.clientId, params.hostClientId),
      eq(boardMembers.userId, params.userId),
      ne(users.clientId, params.hostClientId),
      isNull(boards.archivedAt),
    ));

  return new Set(rows.map((row) => row.boardId).concat(params.includeBoardId ? [params.includeBoardId] : [], params.includeBoardIds ?? []));
}

export async function ensureGuestBoardCapacity(params: {
  hostClientId: string;
  boardId: string;
  userId: string;
  targetClientId?: string;
  createdById?: string;
  tx?: Tx;
}): Promise<{ paidGuestSeatCreated: boolean; paidGuestSeatActive: boolean }> {
  return ensureGuestBoardsCapacity({
    ...params,
    boardIds: [params.boardId],
  });
}

export async function previewGuestBoardsCapacity(params: {
  hostClientId: string;
  boardIds: string[];
  userId?: string;
  targetClientId?: string;
  tx?: Tx;
}): Promise<{ paidGuestSeatRequired: boolean; paidGuestSeatActive: boolean }> {
  if (env.KANERA_DEPLOYMENT_MODE !== "hosted") return { paidGuestSeatRequired: false, paidGuestSeatActive: false };
  if (params.targetClientId === params.hostClientId) return { paidGuestSeatRequired: false, paidGuestSeatActive: false };

  const database = params.tx ?? db;
  // Unregistered recipients have no membership rows yet. Their pending invitation grants are passed
  // in by the caller so a bundled second board previews the seat that acceptance will require without
  // reserving it before the recipient has an account.
  const boardIds = params.userId
    ? await guestBoardIds({
      hostClientId: params.hostClientId,
      userId: params.userId,
      includeBoardIds: params.boardIds,
      tx: database,
    })
    : new Set(params.boardIds);
  if (boardIds.size <= env.HOSTED_FREE_MAX_GUEST_BOARDS) return { paidGuestSeatRequired: false, paidGuestSeatActive: false };

  if (!params.userId) {
    await assertSeatPoolAvailable(params.hostClientId, database);
    return { paidGuestSeatRequired: true, paidGuestSeatActive: false };
  }

  const [existingSeat] = await database
    .select({ userId: clientGuestSeats.userId })
    .from(clientGuestSeats)
    .where(and(eq(clientGuestSeats.clientId, params.hostClientId), eq(clientGuestSeats.userId, params.userId)))
    .limit(1);
  if (existingSeat) return { paidGuestSeatRequired: false, paidGuestSeatActive: true };

  await assertSeatPoolAvailable(params.hostClientId, database);
  return { paidGuestSeatRequired: true, paidGuestSeatActive: false };
}

// A guest gets the configured number of boards across the host org for free (one by default); crossing
// that threshold records one client_guest_seat row so checkout/paid billing counts real usage. Paid
// subscriptions also gate against purchased capacity; trials are unlimited until checkout. Run inside
// the caller's locked transaction (pass tx) so the check + insert + membership add are atomic.
export async function ensureGuestBoardsCapacity(params: {
  hostClientId: string;
  boardIds: string[];
  userId: string;
  targetClientId?: string;
  createdById?: string;
  tx?: Tx;
}): Promise<{ paidGuestSeatCreated: boolean; paidGuestSeatActive: boolean }> {
  if (env.KANERA_DEPLOYMENT_MODE !== "hosted") return { paidGuestSeatCreated: false, paidGuestSeatActive: false };
  if (params.targetClientId === params.hostClientId) return { paidGuestSeatCreated: false, paidGuestSeatActive: false };

  const database = params.tx ?? db;
  const boardIds = await guestBoardIds({
    hostClientId: params.hostClientId,
    userId: params.userId,
    includeBoardIds: params.boardIds,
    tx: database,
  });
  if (boardIds.size <= env.HOSTED_FREE_MAX_GUEST_BOARDS) return { paidGuestSeatCreated: false, paidGuestSeatActive: false };

  const [existingSeat] = await database
    .select({ userId: clientGuestSeats.userId })
    .from(clientGuestSeats)
    .where(and(eq(clientGuestSeats.clientId, params.hostClientId), eq(clientGuestSeats.userId, params.userId)))
    .limit(1);
  if (existingSeat) return { paidGuestSeatCreated: false, paidGuestSeatActive: true };

  // Will this guest seat fit in the purchased pool? Throws 402 SEAT_LIMIT_REACHED if not.
  await assertSeatPoolAvailable(params.hostClientId, database);

  await database
    .insert(clientGuestSeats)
    .values({
      clientId: params.hostClientId,
      userId: params.userId,
      createdById: params.createdById ?? null,
    })
    .onConflictDoNothing();
  return { paidGuestSeatCreated: true, paidGuestSeatActive: true };
}

// Frees the guest's pool seat when removing a board drops them back to/under the free board limit. This
// only changes the *used* seat count; the purchased seat_limit (and the bill) is unchanged — reducing
// capacity is a separate explicit admin action (setSeatCapacity).
export async function prunePaidGuestSeatIfBelowLimit(params: {
  hostClientId: string;
  userId: string;
  tx?: Tx;
}): Promise<{ paidGuestSeatRemoved: boolean }> {
  if (env.KANERA_DEPLOYMENT_MODE !== "hosted") return { paidGuestSeatRemoved: false };
  const database = params.tx ?? db;
  const boardIds = await guestBoardIds({
    hostClientId: params.hostClientId,
    userId: params.userId,
    tx: database,
  });
  if (boardIds.size > env.HOSTED_FREE_MAX_GUEST_BOARDS) return { paidGuestSeatRemoved: false };

  const deleted = await database
    .delete(clientGuestSeats)
    .where(and(eq(clientGuestSeats.clientId, params.hostClientId), eq(clientGuestSeats.userId, params.userId)))
    .returning({ userId: clientGuestSeats.userId });
  return { paidGuestSeatRemoved: deleted.length > 0 };
}
