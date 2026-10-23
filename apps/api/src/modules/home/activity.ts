import type { HomeActivityItem, HomeActivityKind, HomeActivityResponse } from "@kanera/shared/dto";
import { HOME_ACTIVITY_DAYS, HOME_ACTIVITY_LIMIT } from "@kanera/shared/dto";
import { activityEvents, cards, comments, lists } from "@kanera/shared/schema";
import { and, desc, eq, gte, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { assignedCardVisibility } from "../../lib/access.js";
import { loadAccessibleBoards } from "../../lib/accessible-boards.js";

/** The raw card actions the panel shows; everything else on a board is left to the board's feed. */
const CARD_ACTIONS = ["created", "moved", "completed", "uncompleted", "completion:set", "assignees:set", "attachment_added"];

/**
 * The card an event is about: the entity itself for card events, the payload's parent for comment
 * events. Same expression as `activity_events_card_lookup_created_at_idx`.
 */
const eventCardId = sql`(case when ${activityEvents.entityType} = 'card' then ${activityEvents.entityId} else (${activityEvents.payload}->>'cardId')::uuid end)`;

function activityKind(entityType: string, action: string, payload: Record<string, unknown>): HomeActivityKind | null {
  if (entityType === "comment") return action === "created" ? "commented" : null;
  switch (action) {
    case "created": return "created";
    case "moved": return "moved";
    case "completed": return "completed";
    case "uncompleted": return "reopened";
    // A coalesced toggle run reports where it ended, which is the only state worth announcing.
    case "completion:set": return payload.toValue === true ? "completed" : "reopened";
    case "assignees:set": return "assigned";
    case "attachment_added": return "attached";
    default: return null;
  }
}

/**
 * What the viewer did recently, across every board they can still open, newest first.
 *
 * Only the viewer's own actions, made in person or by an AI agent acting for them; API keys and
 * support sessions are not the person. Access still follows the board feeds (board membership via
 * `loadAccessibleBoards`, and on assigned-items-only boards only cards the viewer can see), and the
 * card must still sit on an accessible board unarchived, so a row never links to something that
 * will not open after access changed.
 */
export async function loadHomeActivity(auth: AuthClaims): Promise<HomeActivityResponse> {
  const accessibleBoards = await loadAccessibleBoards(auth);
  if (accessibleBoards.length === 0) return { items: [] };

  const boardIds = accessibleBoards.map((board) => board.id);
  const boardsById = new Map(accessibleBoards.map((board) => [board.id, board]));
  const restrictedBoardIds = accessibleBoards.filter((board) => board.assignedItemsOnly).map((board) => board.id);
  const since = new Date(Date.now() - HOME_ACTIVITY_DAYS * 86_400_000);

  const rows = await db
    .select({
      id: activityEvents.id,
      entityType: activityEvents.entityType,
      action: activityEvents.action,
      payload: activityEvents.payload,
      actorKind: activityEvents.actorKind,
      agentName: activityEvents.agentName,
      createdAt: activityEvents.createdAt,
      cardId: cards.id,
      cardKey: cards.key,
      organisationKey: cards.organisationKey,
      cardTitle: cards.title,
      cardBoardId: cards.boardId,
      listName: lists.name,
      listIcon: lists.icon,
      listColor: lists.color,
    })
    .from(activityEvents)
    .innerJoin(cards, eq(cards.id, eventCardId))
    .leftJoin(comments, and(eq(activityEvents.entityType, "comment"), eq(comments.id, activityEvents.entityId)))
    .leftJoin(lists, and(eq(activityEvents.action, "moved"), sql`${lists.id} = (${activityEvents.payload}->>'toListId')::uuid`))
    .where(and(
      eq(activityEvents.actorId, auth.sub),
      inArray(activityEvents.actorKind, ["user", "agent"]),
      inArray(activityEvents.boardId, boardIds),
      gte(activityEvents.createdAt, since),
      eq(activityEvents.feedVisible, true),
      or(
        and(eq(activityEvents.entityType, "card"), inArray(activityEvents.action, CARD_ACTIONS)),
        // A deleted comment leaves its audit row behind; announcing it would link to nothing.
        and(eq(activityEvents.entityType, "comment"), eq(activityEvents.action, "created"), sql`${comments.id} is not null`),
      ),
      // Mirror copies of a source board's events are not something the viewer did here.
      sql`${activityEvents.coalesceKey} is distinct from 'card:mirrorSync'`,
      inArray(cards.boardId, boardIds),
      isNull(cards.archivedAt),
      restrictedBoardIds.length
        ? or(notInArray(cards.boardId, restrictedBoardIds), assignedCardVisibility(auth.sub, cards.id))
        : undefined,
    ))
    .orderBy(desc(activityEvents.createdAt), desc(activityEvents.id))
    .limit(HOME_ACTIVITY_LIMIT * 2);

  const items: HomeActivityItem[] = [];
  for (const row of rows) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const kind = activityKind(row.entityType, row.action, payload);
    const board = boardsById.get(row.cardBoardId);
    if (!kind || !board) continue;
    items.push({
      id: row.id,
      kind,
      createdAt: row.createdAt.toISOString(),
      viaAgent: row.actorKind === "agent",
      agentName: row.actorKind === "agent" ? row.agentName : null,
      card: { id: row.cardId, key: row.cardKey, organisationKey: row.organisationKey, title: row.cardTitle },
      board: { id: board.id, name: board.name, icon: board.icon, iconColor: board.iconColor },
      list: kind === "moved" && row.listName ? { name: row.listName, icon: row.listIcon, color: row.listColor } : null,
    });
    if (items.length === HOME_ACTIVITY_LIMIT) break;
  }
  return { items };
}
