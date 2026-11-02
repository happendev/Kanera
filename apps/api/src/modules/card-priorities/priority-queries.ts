import type {
  WorkPrioritiesResponse,
  WorkPriorityItem,
  WorkPriorityQueuesResponse,
  WorkPriorityTarget,
  WorkPriorityTargetsResponse,
} from "@kanera/shared/dto";
import {
  cardAssignees,
  cardPriorities,
  cards,
  clients,
  users,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import { and, asc, countDistinct, eq, inArray, isNull } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { isOrgAdmin } from "../../lib/access.js";
import { loadAccessibleBoards, type AccessibleBoard } from "../../lib/accessible-boards.js";
import { cardAccessCondition, cardDueColumns } from "../../lib/card-due-sql.js";
import {
  liveQueueCardCondition,
  priorityQueueLabels,
  priorityQueueRows,
  toPriorityQueueItem,
} from "../../lib/card-priority-queue.js";
import { forbidden } from "../../lib/errors.js";
import { effectiveMcpPolicy } from "../../lib/mcp-policy.js";
import {
  canWritePriorityQueues,
  isWorkspaceCredential,
  liveBaseQueueEntryCondition,
  visibleLiveEntryIds,
} from "./route-support.js";

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
export async function loadPriorities(
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
    priorityQueueRows(and(eq(cardPriorities.targetUserId, targetUserId), liveQueueCardCondition)),
  ]);

  // Only for entries this viewer may actually see: a redacted row discloses no board, list or label.
  const labelsByCardId = await priorityQueueLabels(
    rows.flatMap((row) => (visibleIds.has(row.card_priority.id) ? [row.card_priority.cardId] : [])),
  );

  const ranked: WorkPriorityItem[] = rows.map((row, index) =>
    toPriorityQueueItem(row, index + 1, {
      visible: visibleIds.has(row.card_priority.id),
      clientId: auth.cid,
      labels: labelsByCardId.get(row.card_priority.cardId) ?? [],
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
export async function loadPriorityTargets(
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
  let authorityWorkspaceIds = [...new Set([...adminRows, ...ownedRows].map((row) => row.workspaceId))];
  // Personal agent credentials must not list teammates of organisations whose MCP policy is off.
  if (auth.apiKeyKind === "personal" && authorityWorkspaceIds.length) {
    const allowed = await db
      .select({ workspaceId: workspaces.id, mcpPolicy: clients.mcpPolicy })
      .from(workspaces)
      .innerJoin(clients, eq(clients.id, workspaces.clientId))
      .where(inArray(workspaces.id, authorityWorkspaceIds));
    authorityWorkspaceIds = allowed.filter((row) => effectiveMcpPolicy(row.mcpPolicy) !== "off").map((row) => row.workspaceId);
  }

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
export async function loadPriorityQueues(auth: AuthClaims): Promise<WorkPriorityQueuesResponse> {
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
    priorityQueueRows(and(inArray(cardPriorities.targetUserId, targetIds), liveQueueCardCondition)),
  ]);
  const visibleIds = new Set(visibleRows.map((row) => row.id));
  const rowsByTarget = new Map<string, typeof rows>();
  for (const row of rows) {
    const targetRows = rowsByTarget.get(row.card_priority.targetUserId) ?? [];
    targetRows.push(row);
    rowsByTarget.set(row.card_priority.targetUserId, targetRows);
  }
  const allWorkspaceIds = [...new Set(accessibleBoards.map((board) => board.workspaceId))];
  // Deduped across every lane, so the whole batch costs one extra statement rather than one per
  // target. Visible entries only — a redacted row discloses no labels, exactly as it discloses no
  // board or list name.
  const labelsByCardId = await priorityQueueLabels([...new Set(
    rows.flatMap((row) => (visibleIds.has(row.card_priority.id) ? [row.card_priority.cardId] : [])),
  )]);
  const queues = targets.map((target) => {
    const targetRows = rowsByTarget.get(target.userId) ?? [];
    const items: WorkPriorityItem[] = targetRows.map((row, index) =>
      toPriorityQueueItem(row, index + 1, {
        visible: visibleIds.has(row.card_priority.id),
        clientId: auth.cid,
        labels: labelsByCardId.get(row.card_priority.cardId) ?? [],
      }));
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
