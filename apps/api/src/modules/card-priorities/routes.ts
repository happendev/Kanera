import { dto } from "@kanera/shared";
import type {
  WorkPrioritiesResponse,
  WorkPriorityItem,
  WorkPriorityQueuesResponse,
  WorkPriorityTarget,
  WorkPriorityTargetsResponse,
} from "@kanera/shared/dto";
import { compactCardSummary } from "@kanera/shared/events";
import {
  ACTIVITY_ACTION,
  ACTIVITY_ENTITY_TYPE,
  boards,
  cardAssignees,
  cardPriorities,
  cardSummaryView,
  cards,
  lists,
  MAX_CARD_PRIORITIES_PER_USER,
  users,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import { and, asc, countDistinct, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AuthClaims } from "../../auth/plugin.js";
import { db, type Db } from "../../db.js";
import { assertCardAccess, isOrgAdmin } from "../../lib/access.js";
import { loadAccessibleBoards, type AccessibleBoard } from "../../lib/accessible-boards.js";
import { recordActivity } from "../../lib/activity.js";
import { cardAccessCondition, cardDueColumns, cardSummaryDueColumns } from "../../lib/card-due-sql.js";
import { toWireCardSummary } from "../../lib/card-summary.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { between } from "../../lib/position.js";
import { rebalanceCardPriorities } from "../../lib/rebalance.js";
import { emitCardPriorityInvalidated } from "../../realtime/emit.js";
import { assertGlobalWorkSeparatorContext } from "../global-work-separators/routes.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type QueueEntry = { id: string; cardId: string; position: string };

function isWorkspaceCredential(auth: AuthClaims): boolean {
  return auth.apiKeyKind === "workspace";
}

function canWritePriorityQueues(auth: AuthClaims): boolean {
  return auth.apiKeyScope !== "read";
}

/**
 * Workspaces whose admin relationship lets this viewer read `targetUserId`'s queue.
 *
 * Workspace credentials are intentionally different from user and personal credentials: only an
 * admin-scoped key borrows authority, and its accessible-board catalog already pins that authority
 * to the key's one workspace. Read/write workspace keys still read their owner's queue, but must not
 * inherit the owner's raw admin memberships to inspect somebody else's private ordering.
 */
async function readableWorkspaceIds(
  auth: AuthClaims,
  targetUserId: string,
  accessibleBoards: AccessibleBoard[],
): Promise<string[]> {
  const workspaceIds = [...new Set(accessibleBoards.map((board) => board.workspaceId))];
  if (workspaceIds.length === 0) return [];
  // Your own queue is always readable wherever this credential can see a card, including guest
  // boards where the user has no workspace membership.
  if (targetUserId === auth.sub) return workspaceIds;

  if (isWorkspaceCredential(auth) && auth.apiKeyScope !== "admin") return [];

  const [membershipRows, ownedWorkspaceRows, targetRows] = await Promise.all([
    isWorkspaceCredential(auth)
      ? Promise.resolve(workspaceIds.map((workspaceId) => ({ workspaceId, role: "admin" as const })))
      : db
        .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.userId, auth.sub), inArray(workspaceMembers.workspaceId, workspaceIds))),
    !isWorkspaceCredential(auth) && isOrgAdmin(auth)
      ? db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(eq(workspaces.clientId, auth.cid), inArray(workspaces.id, workspaceIds)))
      : Promise.resolve([]),
    db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, targetUserId), inArray(workspaceMembers.workspaceId, workspaceIds))),
  ]);

  const targetWorkspaceIds = new Set(targetRows.map((row) => row.workspaceId));
  const eligible = new Set<string>(ownedWorkspaceRows.map((row) => row.id));
  for (const membership of membershipRows) {
    if (targetUserId === auth.sub || membership.role === "admin") eligible.add(membership.workspaceId);
  }
  return [...eligible].filter((workspaceId) => targetWorkspaceIds.has(workspaceId));
}

/** Workspaces where this credential may mutate the queue, after its read scope is established. */
async function reorderableWorkspaceIds(
  auth: AuthClaims,
  targetUserId: string,
  accessibleBoards: AccessibleBoard[],
  readableIds?: string[],
): Promise<string[]> {
  if (!canWritePriorityQueues(auth)) return [];
  if (targetUserId === auth.sub) {
    return [...new Set(accessibleBoards.map((board) => board.workspaceId))];
  }
  return readableIds ?? readableWorkspaceIds(auth, targetUserId, accessibleBoards);
}

/**
 * Serialise all writes to one user's queue.
 *
 * Row locks alone cannot do this: `lockedQueue`'s FOR UPDATE locks nothing when the queue is empty,
 * so two concurrent first adds would both interpolate against an empty list and race the unique
 * index. A transaction-scoped advisory lock keyed on the target closes that gap; taking it first in
 * *every* write transaction also gives them one uniform lock order, so a create and a move on the
 * same queue can never deadlock on each other's row locks.
 */
async function lockQueueForWrite(targetUserId: string, tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`card_priority:${targetUserId}`}, 0))`);
}

/**
 * The whole queue, locked and in canonical order — unfiltered by lifecycle or visibility.
 *
 * Anchor interpolation runs against this after anchor eligibility is checked against the live set.
 * Filtering it to the actor's visible subset is exactly where `positionForGlobalWorkLaneInsert`
 * would mislead: a manager who sees
 * 1, 2, 5 and drops "after 2" must not silently reorder the invisible 3 and 4.
 */
async function lockedQueue(targetUserId: string, tx: Tx): Promise<QueueEntry[]> {
  return tx
    .select({ id: cardPriorities.id, cardId: cardPriorities.cardId, position: cardPriorities.position })
    .from(cardPriorities)
    .where(eq(cardPriorities.targetUserId, targetUserId))
    .for("update")
    .orderBy(asc(cardPriorities.position), asc(cardPriorities.cardId));
}

/**
 * What counts as being *in* the queue.
 *
 * A queue answers "what's next", so completed and archived cards drop out of it. This is the one
 * place the board rule "completing a card must not make it vanish from the list you completed it in"
 * deliberately does not apply: leaving a done card ranked made the top of the list read as a
 * struck-through no-op. The row itself survives, so un-completing or un-archiving restores the card
 * at its original position, and every count the client sees — rank, `totalCount`, the entry cap —
 * is taken over this same set so they cannot disagree.
 *
 * Survival is time-boxed for completion: the completed-priority-cleanup sweep deletes rows whose
 * card has been done past a 24h grace window, so the restore-on-uncomplete behaviour is an undo for
 * mis-clicks, not a promise that reopening months-old work resurrects its old rank.
 */
const liveQueueCardCondition = and(
  isNull(cardSummaryView.archivedAt),
  isNull(cardSummaryView.completedAt),
);

/** The target's assigned, active rows — the one set used for ranks, counts, caps and anchors. */
function liveQueueEntryCondition(targetUserId: string) {
  return and(
    eq(cardPriorities.targetUserId, targetUserId),
    eq(cardAssignees.userId, targetUserId),
    liveQueueCardCondition,
  );
}

/** Narrow-table form for rank/count/visibility reads that do not need card hydration. */
function liveBaseQueueEntryCondition(targetUserId: string) {
  return and(
    eq(cardPriorities.targetUserId, targetUserId),
    eq(cardAssignees.userId, targetUserId),
    isNull(cards.archivedAt),
    isNull(cards.completedAt),
  );
}

/**
 * A user's live queue as cardId → 1-based rank.
 *
 * Exactly the row set and ordering `loadPriorities` numbers (live cards still assigned to the
 * target), so a rank annotated onto a card elsewhere — the work card queries wear it as
 * `viewerPriorityRank` — always agrees with the number the queue endpoint and panel show.
 */
export async function liveQueueRanksByCardId(targetUserId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ cardId: cardPriorities.cardId })
    .from(cardPriorities)
    .innerJoin(cards, eq(cards.id, cardPriorities.cardId))
    .innerJoin(cardAssignees, eq(cardAssignees.cardId, cardPriorities.cardId))
    .where(liveBaseQueueEntryCondition(targetUserId))
    .orderBy(asc(cardPriorities.position), asc(cardPriorities.cardId));
  return new Map(rows.map((row, index) => [row.cardId, index + 1]));
}

/** How many live entries the queue holds. The entry cap counts these, not raw rows. */
async function liveQueueSize(targetUserId: string, tx: Tx): Promise<number> {
  const [row] = await tx
    .select({ count: countDistinct(cardPriorities.id) })
    .from(cardPriorities)
    .innerJoin(cards, eq(cards.id, cardPriorities.cardId))
    .innerJoin(cardAssignees, eq(cardAssignees.cardId, cardPriorities.cardId))
    .where(liveBaseQueueEntryCondition(targetUserId));
  return row?.count ?? 0;
}

/** Live priority-entry ids whose card this actor may see. Dormant rows are never valid anchors. */
async function visibleLiveEntryIds(
  auth: AuthClaims,
  targetUserId: string,
  accessibleBoards: AccessibleBoard[],
  tx: Tx,
): Promise<Set<string>> {
  if (accessibleBoards.length === 0) return new Set();
  const rows = await tx
    .select({ id: cardPriorities.id })
    .from(cardPriorities)
    .innerJoin(cards, eq(cards.id, cardPriorities.cardId))
    .innerJoin(cardAssignees, eq(cardAssignees.cardId, cardPriorities.cardId))
    .where(and(
      liveBaseQueueEntryCondition(targetUserId),
      cardAccessCondition(auth.sub, accessibleBoards, cardDueColumns),
    ));
  return new Set(rows.map((row) => row.id));
}

/**
 * Interpolate a position from the anchors the client supplied.
 *
 * The anchor must resolve to an entry the actor can see — never fall back silently, because the
 * client only ever renders anchors the server gave it. `prev`/`next` then come from the *full*
 * ordered list including invisible neighbours, so the card lands exactly where intended and hidden
 * entries keep their relative order.
 *
 * Leak analysis: because `next` may be an invisible entry's position, the returned position reveals
 * a numeric *interval* — "something exists between #2 and #5". The actor already learns that from
 * `hiddenCount` and the placeholder rows, and no card identity, title, board or workspace leaks. The
 * alternative silently reorders cards in workspaces the actor has no rights over, which is worse.
 */
function positionForAnchors(
  entries: QueueEntry[],
  visibleIds: Set<string>,
  anchors: { afterId?: string | null; beforeId?: string | null },
): { position: string; needsRebalance: boolean } {
  const findAnchor = (id: string) => {
    const index = entries.findIndex((entry) => entry.id === id);
    if (index === -1 || !visibleIds.has(id)) throw badRequest("priority anchor is not visible");
    return index;
  };

  let prev: string | null = null;
  let next: string | null = null;
  if (anchors.afterId === null && anchors.beforeId === undefined) {
    next = entries[0]?.position ?? null;
  } else if (anchors.beforeId === null && anchors.afterId === undefined) {
    prev = entries.at(-1)?.position ?? null;
  } else if (anchors.afterId) {
    const index = findAnchor(anchors.afterId);
    prev = entries[index]!.position;
    next = entries[index + 1]?.position ?? null;
  } else if (anchors.beforeId) {
    const index = findAnchor(anchors.beforeId);
    next = entries[index]!.position;
    prev = entries[index - 1]?.position ?? null;
  }

  return between(prev, next);
}

/**
 * The queue as this viewer may see it.
 *
 * Rank is numbered over the *target's* set — the rows surviving the target's lifecycle filters — and
 * the viewer's own visibility only redacts. A manager who can see 3 of 5 entries therefore reads
 * 1, 2, 5, never a renumbered 1, 2, 3; otherwise the manager and the assignee would say different
 * numbers about the same card. No separate "target visibility" pass is needed: every entry is a card
 * assigned to the target and losing board access deletes the row, so the target is never partially
 * sighted and `hiddenCount > 0` only ever happens for managers.
 */
async function loadPriorities(
  auth: AuthClaims,
  targetUserId: string,
  options: { limit?: number; accessibleBoards?: AccessibleBoard[] } = {},
): Promise<WorkPrioritiesResponse> {
  // `accessibleBoards` is caller-independent per credential, so the batch loader resolves it once
  // and threads it through instead of recomputing it for every lane.
  const accessibleBoards = options.accessibleBoards ?? await loadAccessibleBoards(auth);
  const readableIds = await readableWorkspaceIds(auth, targetUserId, accessibleBoards);
  // Your own queue is always readable. Somebody else's requires effective admin authority, including
  // the workspace-key scope check above; raw memberships alone must never admit a pinned key.
  if (targetUserId !== auth.sub && readableIds.length === 0) throw forbidden();
  const writableIds = await reorderableWorkspaceIds(auth, targetUserId, accessibleBoards, readableIds);

  // Redaction, not filtering: an entry the viewer cannot see must still occupy its rank, so
  // visibility is resolved as a separate id set rather than folded into the WHERE clause.
  const [visibleIds, rows] = await Promise.all([
    visibleLiveEntryIds(auth, targetUserId, accessibleBoards, db),
    db
    .select()
    .from(cardPriorities)
    .innerJoin(cardSummaryView, eq(cardSummaryView.id, cardPriorities.cardId))
    .innerJoin(workspaces, eq(workspaces.id, cardSummaryView.workspaceId))
    // Board and list rows are joined for their names: a queue spanning several boards is unreadable
    // without them, and Home has no work catalog to resolve ids against.
    .innerJoin(boards, eq(boards.id, cardSummaryView.boardId))
    .innerJoin(lists, eq(lists.id, cardSummaryView.listId))
    // Belt-and-braces beside `cleanupUserBoardParticipation`: a missed cleanup call site degrades to
    // "not shown" rather than lying to the assignee. Re-assigning also restores the original rank,
    // which is what you want when a mis-assignment is corrected.
    .innerJoin(cardAssignees, eq(cardAssignees.cardId, cardPriorities.cardId))
    .where(liveQueueEntryCondition(targetUserId))
    .orderBy(asc(cardPriorities.position), asc(cardPriorities.cardId)),
  ]);

  const ranked: WorkPriorityItem[] = rows.map((row, index) => ({
    id: row.card_priority.id,
    position: row.card_priority.position,
    rank: index + 1,
    // Same projection `workCards()` runs, so a WorkCard from either endpoint is shape-identical.
    // `lastActivityAt`/`lastMovedAt` are deliberately absent: they are not part of the WorkCard type,
    // and neither the Priorities display nor the Home block renders staleness.
    card: visibleIds.has(row.card_priority.id)
      ? {
          ...compactCardSummary(toWireCardSummary(row.card_summary_view, auth.cid)),
          workspaceId: row.card_summary_view.workspaceId,
        }
      : null,
    // Redacted with the card: an entry the viewer cannot see must disclose no board or list name.
    context: visibleIds.has(row.card_priority.id)
      ? {
          boardName: row.board.name,
          boardIcon: row.board.icon,
          boardIconColor: row.board.iconColor,
          listName: row.list.name,
          workspaceName: row.workspace.name,
        }
      : null,
  }));

  return {
    targetUserId,
    items: options.limit === undefined ? ranked : ranked.slice(0, options.limit),
    // Both counts describe the full queue, before `limit`, so a truncated Home block can still say
    // how much it is not showing.
    totalCount: ranked.length,
    hiddenCount: ranked.filter((item) => item.card === null).length,
    canReorder: writableIds.length > 0,
    reorderableWorkspaceIds: writableIds,
  };
}

/**
 * Everyone whose queue this caller may read through an admin relationship.
 *
 * Discovery for managers: the get/add/move/remove routes are all addressed by target user id, and
 * without this an integration has to hold user ids from somewhere else before it can do anything.
 * The eligibility rule is the same triple as `readableWorkspaceIds` — workspaces where the
 * caller holds admin authority (membership role or org admin), intersected with each target's own
 * memberships — but inverted to enumerate users instead of validating one. The caller is always
 * included (`self: true`): your own queue needs no authority at all.
 *
 * Exposing member emails here matches the workspace-members listing, which every workspace member
 * (let alone an admin) can already read.
 */
async function loadPriorityTargets(
  auth: AuthClaims,
  options: { accessibleBoards?: AccessibleBoard[] } = {},
): Promise<WorkPriorityTargetsResponse> {
  const accessibleBoards = options.accessibleBoards ?? await loadAccessibleBoards(auth);
  const workspaceCredential = isWorkspaceCredential(auth);
  const [adminRows, ownedRows] = await Promise.all([
    workspaceCredential
      ? Promise.resolve(auth.apiKeyScope === "admin"
        ? [...new Set(accessibleBoards.map((board) => board.workspaceId))].map((workspaceId) => ({ workspaceId }))
        : [])
      : db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.userId, auth.sub), eq(workspaceMembers.role, "admin"))),
    !workspaceCredential && isOrgAdmin(auth)
      ? db.select({ workspaceId: workspaces.id }).from(workspaces).where(eq(workspaces.clientId, auth.cid))
      : Promise.resolve([] as { workspaceId: string }[]),
  ]);
  const authorityWorkspaceIds = [...new Set([...adminRows, ...ownedRows].map((row) => row.workspaceId))];

  const memberRows = authorityWorkspaceIds.length
    ? await db
      .select({
        userId: workspaceMembers.userId,
        workspaceId: workspaceMembers.workspaceId,
        displayName: users.displayName,
        email: users.email,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(inArray(workspaceMembers.workspaceId, authorityWorkspaceIds))
    : [];

  const byUser = new Map<string, WorkPriorityTarget>();
  for (const row of memberRows) {
    const target = byUser.get(row.userId) ?? {
      userId: row.userId,
      displayName: row.displayName,
      email: row.email,
      self: row.userId === auth.sub,
      workspaceIds: [],
      queueSize: 0,
    };
    target.workspaceIds.push(row.workspaceId);
    byUser.set(row.userId, target);
  }
  if (!byUser.has(auth.sub)) {
    const [me] = await db
      .select({ displayName: users.displayName, email: users.email })
      .from(users)
      .where(eq(users.id, auth.sub))
      .limit(1);
    if (me) byUser.set(auth.sub, { userId: auth.sub, displayName: me.displayName, email: me.email, self: true, workspaceIds: [], queueSize: 0 });
  }

  // Same row set `loadPriorities` numbers (live cards still assigned to the target), so a
  // target's queueSize always equals the totalCount the per-queue endpoint would report.
  const countRows = byUser.size
    ? await db
      .select({ targetUserId: cardPriorities.targetUserId, count: countDistinct(cardPriorities.id) })
      .from(cardPriorities)
      .innerJoin(cards, eq(cards.id, cardPriorities.cardId))
      .innerJoin(cardAssignees, and(
        eq(cardAssignees.cardId, cardPriorities.cardId),
        eq(cardAssignees.userId, cardPriorities.targetUserId),
      ))
      .where(and(
        inArray(cardPriorities.targetUserId, [...byUser.keys()]),
        isNull(cards.archivedAt),
        isNull(cards.completedAt),
      ))
      .groupBy(cardPriorities.targetUserId)
    : [];
  for (const row of countRows) {
    const target = byUser.get(row.targetUserId);
    if (target) target.queueSize = row.count;
  }

  const targets = [...byUser.values()].sort((a, b) =>
    a.self !== b.self ? (a.self ? -1 : 1) : a.displayName.localeCompare(b.displayName));
  return { targets };
}

/**
 * Every queue this caller may read, in one response — the Team Cards lanes display.
 *
 * Targets come from the same eligibility rule as `/work/priority-targets` and each lane is the
 * exact response the per-target endpoint would return (same redaction, ranks, and write scope), so
 * a lane and a focused queue can never disagree. Empty queues are included deliberately: "nothing
 * queued for this person" is precisely what a manager's overview exists to show. The per-target
 * Queue rows and visibility are loaded across every target in two bounded statements. Read/write
 * scopes are already encoded in each discovered target's workspace ids, avoiding a fanout of
 * authority and queue queries as a team grows.
 */
async function loadPriorityQueues(auth: AuthClaims): Promise<WorkPriorityQueuesResponse> {
  const accessibleBoards = await loadAccessibleBoards(auth);
  const { targets } = await loadPriorityTargets(auth, { accessibleBoards });
  if (targets.length === 0) return { queues: [] };
  const targetIds = targets.map((target) => target.userId);
  const liveBatchCondition = and(
    inArray(cardPriorities.targetUserId, targetIds),
    isNull(cards.archivedAt),
    isNull(cards.completedAt),
  );
  const [visibleRows, rows] = await Promise.all([
    db
      .select({ id: cardPriorities.id })
      .from(cardPriorities)
      .innerJoin(cards, eq(cards.id, cardPriorities.cardId))
      .innerJoin(cardAssignees, and(
        eq(cardAssignees.cardId, cardPriorities.cardId),
        eq(cardAssignees.userId, cardPriorities.targetUserId),
      ))
      .where(and(liveBatchCondition, cardAccessCondition(auth.sub, accessibleBoards, cardDueColumns))),
    db
      .select()
      .from(cardPriorities)
      .innerJoin(cardSummaryView, eq(cardSummaryView.id, cardPriorities.cardId))
      .innerJoin(workspaces, eq(workspaces.id, cardSummaryView.workspaceId))
      .innerJoin(boards, eq(boards.id, cardSummaryView.boardId))
      .innerJoin(lists, eq(lists.id, cardSummaryView.listId))
      .innerJoin(cardAssignees, and(
        eq(cardAssignees.cardId, cardPriorities.cardId),
        eq(cardAssignees.userId, cardPriorities.targetUserId),
      ))
      .where(and(
        inArray(cardPriorities.targetUserId, targetIds),
        liveQueueCardCondition,
      ))
      .orderBy(asc(cardPriorities.targetUserId), asc(cardPriorities.position), asc(cardPriorities.cardId)),
  ]);
  const visibleIds = new Set(visibleRows.map((row) => row.id));
  const rowsByTarget = new Map<string, typeof rows>();
  for (const row of rows) {
    const targetRows = rowsByTarget.get(row.card_priority.targetUserId) ?? [];
    targetRows.push(row);
    rowsByTarget.set(row.card_priority.targetUserId, targetRows);
  }
  const allWorkspaceIds = [...new Set(accessibleBoards.map((board) => board.workspaceId))];
  const queues = targets.map((target) => {
    const targetRows = rowsByTarget.get(target.userId) ?? [];
    const items: WorkPriorityItem[] = targetRows.map((row, index) => {
      const visible = visibleIds.has(row.card_priority.id);
      return {
        id: row.card_priority.id,
        position: row.card_priority.position,
        rank: index + 1,
        card: visible ? {
          ...compactCardSummary(toWireCardSummary(row.card_summary_view, auth.cid)),
          workspaceId: row.card_summary_view.workspaceId,
        } : null,
        context: visible ? {
          boardName: row.board.name,
          boardIcon: row.board.icon,
          boardIconColor: row.board.iconColor,
          listName: row.list.name,
          workspaceName: row.workspace.name,
        } : null,
      };
    });
    const reorderableWorkspaceIds = canWritePriorityQueues(auth)
      ? target.self ? allWorkspaceIds : target.workspaceIds
      : [];
    return {
      target,
      queue: {
        targetUserId: target.userId,
        items,
        totalCount: items.length,
        hiddenCount: items.filter((item) => item.card === null).length,
        canReorder: reorderableWorkspaceIds.length > 0,
        reorderableWorkspaceIds,
      },
    };
  });
  return { queues };
}

/**
 * Authorise one write against the touched card's *own* workspace.
 *
 * Not a queue-level check: "admin of some workspace shared with the target" would let an admin of
 * one small shared workspace reorder entries belonging to workspaces where they have no authority at
 * all — a privilege escalation across exactly the boundary `assertOrganisationContext` and
 * `canAccessWorkspace` exist to guard. `"observer"` rather than `"editor"` because prioritising is
 * not editing the card.
 */
async function assertPriorityWriteAccess(auth: AuthClaims, cardId: string, targetUserId: string) {
  // The "observer" floor below is what lets a viewer sequence work they cannot edit — but it also
  // means the usual scope-to-rank mapping never trips for read-scoped integration credentials, so
  // "read-only credentials cannot mutate" must be enforced here explicitly for the public API.
  if (auth.apiKeyScope === "read") throw forbidden();
  const ctx = await assertCardAccess(auth, cardId, "observer");
  // Your own queue is always yours, so seeing the card is the whole test. The separator context gate
  // additionally requires workspace *membership*, which a cross-organisation guest never has — and
  // holding a card from an external org's board is exactly the case this table exists to support, so
  // deferring to it here would make a guest unable to sequence their own work. For anyone else's
  // queue it is called verbatim, so one implementation of the cross-user rule exists.
  if (targetUserId !== auth.sub) {
    await assertGlobalWorkSeparatorContext({ auth, workspaceId: ctx.workspaceId, targetUserId });
  }
  return ctx;
}

export async function cardPriorityRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Static path, so it never collides with the :userId route below (the router prefers static
  // segments), and "targets" is not a valid user id anyway.
  app.get("/work/priority-targets", async (req) => loadPriorityTargets(req.auth));

  // Static path beside the :userId route, like /work/priority-targets above.
  app.get("/work/priorities", async (req) => loadPriorityQueues(req.auth));

  app.get("/work/priorities/:userId", async (req) => {
    const { userId: targetUserId } = req.params as { userId: string };
    const query = dto.cardPrioritiesQuery.parse(req.query ?? {});
    return loadPriorities(req.auth, targetUserId, query);
  });

  app.post("/work/priorities/:userId/cards", async (req, reply) => {
    const { userId: targetUserId } = req.params as { userId: string };
    const body = dto.createCardPriorityBody.parse(req.body);
    const ctx = await assertPriorityWriteAccess(req.auth, body.cardId, targetUserId);

    // The queue ranks assignments, so an unassigned card has nothing to rank (same guard the
    // Global Work personal lane applies before it will position a card for someone). And the queue
    // is *live* work: accepting a completed or archived card would create a dormant entry invisible
    // to the very client that asked for it — a 201 whose queue does not contain the card.
    const [candidate] = await db
      .select({ archivedAt: cardSummaryView.archivedAt, completedAt: cardSummaryView.completedAt })
      .from(cardSummaryView)
      .innerJoin(cardAssignees, and(
        eq(cardAssignees.cardId, cardSummaryView.id),
        eq(cardAssignees.userId, targetUserId),
      ))
      .where(eq(cardSummaryView.id, body.cardId))
      .limit(1);
    if (!candidate) throw badRequest("card is not assigned to that user");
    if (candidate.archivedAt || candidate.completedAt) {
      throw badRequest("card is completed or archived");
    }

    const accessibleBoards = await loadAccessibleBoards(req.auth);
    await db.transaction(async (tx) => {
      await lockQueueForWrite(targetUserId, tx);
      // The cap is checked against the *live* size, not these raw rows: a done or archived card is
      // not in the queue, so it must not hold a slot the client cannot see or clear.
      let entries = await lockedQueue(targetUserId, tx);
      // Raw rows, not the live set: a dormant duplicate would still trip the unique index, and a
      // defined 409 beats surfacing that constraint violation as an internal error.
      if (entries.some((entry) => entry.cardId === body.cardId)) {
        throw conflict("card is already in this queue");
      }
      if (await liveQueueSize(targetUserId, tx) >= MAX_CARD_PRIORITIES_PER_USER) {
        throw badRequest(`a priority queue holds at most ${MAX_CARD_PRIORITIES_PER_USER} cards`);
      }
      const visibleIds = await visibleLiveEntryIds(req.auth, targetUserId, accessibleBoards, tx);

      const interpolated = positionForAnchors(entries, visibleIds, body);
      let position = interpolated.position;
      // `between()` reports an exhausted gap; ~30 successive drops into the same slot get there, and
      // ignoring it silently corrupts the order (two equal positions, tiebroken by id).
      if (interpolated.needsRebalance) {
        await rebalanceCardPriorities(targetUserId, tx);
        entries = await lockedQueue(targetUserId, tx);
        position = positionForAnchors(entries, visibleIds, body).position;
      }

      const [created] = await tx
        .insert(cardPriorities)
        .values({ targetUserId, cardId: body.cardId, position, createdById: req.auth.sub })
        .returning();
      if (!created) throw notFound();
      await recordPriorityActivity(tx, {
        auth: req.auth,
        workspaceId: ctx.workspaceId,
        priorityId: created.id,
        cardId: body.cardId,
        targetUserId,
        action: ACTIVITY_ACTION.CREATED,
        payload: { position },
      });
    });

    await emitCardPriorityInvalidated(targetUserId);
    // The full queue, not just the created row: the actor settles optimistically without waiting for
    // their own invalidation echo, and a concurrent reorder by another manager is already folded in.
    return reply.status(201).send(await loadPriorities(req.auth, targetUserId));
  });

  app.post("/card-priorities/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveCardPriorityBody.parse(req.body);
    const [current] = await db.select().from(cardPriorities).where(eq(cardPriorities.id, id)).limit(1);
    if (!current) throw notFound();
    // Checked on the *moved* entry's card only. Anchors are numeric position hints, not things being
    // written; requiring rights over them would make the feature unusable for a workspace admin
    // whose colleague's queue merely contains a card from elsewhere.
    const ctx = await assertPriorityWriteAccess(req.auth, current.cardId, current.targetUserId);

    const accessibleBoards = await loadAccessibleBoards(req.auth);
    const noOp = await db.transaction(async (tx) => {
      await lockQueueForWrite(current.targetUserId, tx);
      // Re-read under the lock: `current` predates this transaction, and a concurrent move may
      // have shifted or removed the row. The fresh position feeds both the no-op check and the
      // audited prevPosition, so neither can describe a queue that no longer exists.
      let locked = await lockedQueue(current.targetUserId, tx);
      let moved = locked.find((entry) => entry.id === id);
      if (!moved) throw notFound();
      let entries = locked.filter((entry) => entry.id !== id);
      const visibleIds = await visibleLiveEntryIds(req.auth, current.targetUserId, accessibleBoards, tx);

      const interpolated = positionForAnchors(entries, visibleIds, body);
      let position = interpolated.position;
      if (interpolated.needsRebalance) {
        await rebalanceCardPriorities(current.targetUserId, tx);
        locked = await lockedQueue(current.targetUserId, tx);
        moved = locked.find((entry) => entry.id === id);
        if (!moved) throw notFound();
        entries = locked.filter((entry) => entry.id !== id);
        position = positionForAnchors(entries, visibleIds, body).position;
      }
      // Drag jitter and client retries must not produce durable outbox rows or audit noise.
      if (position === moved.position) return true;

      await tx.update(cardPriorities).set({ position, updatedAt: new Date() }).where(eq(cardPriorities.id, id));
      await recordPriorityActivity(tx, {
        auth: req.auth,
        workspaceId: ctx.workspaceId,
        priorityId: id,
        cardId: current.cardId,
        targetUserId: current.targetUserId,
        action: ACTIVITY_ACTION.MOVED,
        payload: { prevPosition: moved.position, position },
      });
      return false;
    });

    if (!noOp) await emitCardPriorityInvalidated(current.targetUserId);
    return loadPriorities(req.auth, current.targetUserId);
  });

  app.delete("/card-priorities/:id", async (req) => {
    const { id } = req.params as { id: string };
    const [current] = await db.select().from(cardPriorities).where(eq(cardPriorities.id, id)).limit(1);
    if (!current) throw notFound();
    const ctx = await assertPriorityWriteAccess(req.auth, current.cardId, current.targetUserId);

    const alreadyGone = await db.transaction(async (tx) => {
      await lockQueueForWrite(current.targetUserId, tx);
      // `current` predates this transaction; the delete itself is the authoritative read. A row a
      // concurrent request already removed is an idempotent success, not a second audit entry.
      const [deleted] = await tx
        .delete(cardPriorities)
        .where(eq(cardPriorities.id, id))
        .returning({ position: cardPriorities.position });
      if (!deleted) return true;
      await recordPriorityActivity(tx, {
        auth: req.auth,
        workspaceId: ctx.workspaceId,
        priorityId: id,
        cardId: current.cardId,
        targetUserId: current.targetUserId,
        action: ACTIVITY_ACTION.DELETED,
        payload: { position: deleted.position },
      });
      return false;
    });

    if (!alreadyGone) await emitCardPriorityInvalidated(current.targetUserId);
    return loadPriorities(req.auth, current.targetUserId);
  });
}

/**
 * Audit a priority write without leaking it into any card or board feed.
 *
 * Two separate mechanisms are needed and both are one careless line from being wrong:
 * - `boardId: null` keeps the row out of `GET /boards/:id/activity`, which filters on
 *   `activity_event.board_id`. Using `entityType: "card"` with the card's real board would be worse
 *   still: the card feed queries `entity_type='card' AND entity_id=cardId` with no board filter, so
 *   it would publish one manager's private sequencing to every board member, cross-org guests
 *   included.
 * - The payload key is `priorityCardId`, never `cardId`. Global Work computes `lastActivityBefore` /
 *   `lastMovedBefore` by matching `payload->>'cardId'`, so naming it `cardId` would make a pure
 *   ordering gesture register as "this card was worked on" and silently drop a stale card out of a
 *   staleness report because someone dragged it.
 *
 * `workspaceId` is the card's own workspace, which is what scopes this for organisation-level audit.
 */
async function recordPriorityActivity(
  tx: Tx,
  options: {
    auth: AuthClaims;
    workspaceId: string;
    priorityId: string;
    cardId: string;
    targetUserId: string;
    action: typeof ACTIVITY_ACTION[keyof typeof ACTIVITY_ACTION];
    payload: Record<string, unknown>;
  },
) {
  await recordActivity(tx, {
    boardId: null,
    workspaceId: options.workspaceId,
    actorId: options.auth.sub,
    entityType: ACTIVITY_ENTITY_TYPE.CARD_PRIORITY,
    entityId: options.priorityId,
    action: options.action,
    payload: {
      ...options.payload,
      priorityCardId: options.cardId,
      targetUserId: options.targetUserId,
      scope: "globalWork",
    },
  });
}
