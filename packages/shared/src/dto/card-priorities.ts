import { z } from "zod";
import type { ColorToken } from "../lib/colors.js";
import { MAX_CARD_PRIORITIES_PER_USER } from "../schema/card-priority.js";
import type { WorkCard } from "./work.js";

/**
 * Anchors are bare priority-entry ids rather than the `{type, id}` union the Global Work separator
 * lane needs, because this lane holds exactly one kind of thing.
 */
const priorityAnchors = {
  afterId: z.uuid().nullable().optional(),
  beforeId: z.uuid().nullable().optional(),
};
// Exactly one, not at-least-one: `{afterId: X, beforeId: Y}` has no defined winner and
// `{afterId: null, beforeId: null}` names two different edges, so both must be rejected rather
// than silently resolved by branch order server-side.
const exactlyOneAnchor = (v: { afterId?: unknown; beforeId?: unknown }) =>
  (v.afterId === undefined) !== (v.beforeId === undefined);

export const createCardPriorityBody = z
  .object({ cardId: z.uuid(), ...priorityAnchors })
  .refine(exactlyOneAnchor, "provide exactly one of afterId or beforeId");
export type CreateCardPriorityBody = z.infer<typeof createCardPriorityBody>;

export const moveCardPriorityBody = z
  .object(priorityAnchors)
  .refine(exactlyOneAnchor, "provide exactly one of afterId or beforeId");
export type MoveCardPriorityBody = z.infer<typeof moveCardPriorityBody>;

/**
 * `limit` truncates the response, never the ranking: ranks are computed over the full queue first,
 * so Home's top-5 "#1 #2 #3" always agrees with the numbers My Cards shows.
 */
export const cardPrioritiesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_CARD_PRIORITIES_PER_USER).optional(),
});
export type CardPrioritiesQuery = z.infer<typeof cardPrioritiesQuery>;

export type WorkPriorityItem = {
  /** The `card_priority` row id — this is the anchor id for create/move. */
  id: string;
  position: string;
  /**
   * 1-based, numbered over the *target's* live set, never the viewer's. A manager who can see 3 of 5
   * entries reads 1, 2, 5 — not 1, 2, 3 — or the manager and the assignee would say different
   * numbers about the same card, which defeats the feature. Completed and archived cards are not in
   * the queue at all, so they take no number; that exclusion is viewer-independent and so keeps the
   * manager and the assignee agreeing.
   */
  rank: number;
  /** `null` when the entry is in the queue but its card is invisible to this viewer. */
  card: WorkCard | null;
  /**
   * Where the card lives, resolved server-side and redacted with the card.
   *
   * `WorkCard` carries board/list *ids* but no names, and the Home block has no work catalog to look
   * them up in — an entry rendered without "which board, which list" is unreadable when the queue
   * spans several. Kept alongside `card` rather than inside it so `WorkCard` stays exactly the shape
   * `/work/cards/query` returns.
   */
  context: WorkPriorityContext | null;
};

export type WorkPriorityContext = {
  boardName: string;
  boardIcon: string | null;
  boardIconColor: ColorToken | null;
  listName: string;
  workspaceName: string;
};

/**
 * One user whose "Up next" queue the caller may read through an admin relationship.
 *
 * The caller always appears in their own targets list (`self: true`) — your own queue needs no
 * admin authority — so `workspaceIds` may be empty on that row. Everyone else is listed because
 * they share at least one workspace where the caller holds admin authority; per-write checks
 * still run against the touched card's own workspace.
 */
export type WorkPriorityTarget = {
  userId: string;
  displayName: string;
  email: string;
  self: boolean;
  /** Workspaces granting admin authority to read this queue; credential scope still gates writes. */
  workspaceIds: string[];
  /** Live queue length — the same count the queue endpoint reports as `totalCount`. */
  queueSize: number;
};

export type WorkPriorityTargetsResponse = {
  targets: WorkPriorityTarget[];
};

/** One lane of the Team Cards priorities display: whose queue it is, and the queue itself. */
export type WorkPriorityQueue = {
  target: WorkPriorityTarget;
  queue: WorkPrioritiesResponse;
};

/**
 * Every queue the caller may read, in one response — the batch behind the Team Cards lanes
 * display, so a manager's overview is not N sequential per-target requests. Targets with empty
 * queues are included: "nothing queued for this person" is exactly what an overview must show.
 * Ordered self first, then by display name, matching `/work/priority-targets`.
 */
export type WorkPriorityQueuesResponse = {
  queues: WorkPriorityQueue[];
};

export type WorkPrioritiesResponse = {
  targetUserId: string;
  items: WorkPriorityItem[];
  /** Live queue length, before `limit`. This is also what the entry cap counts. */
  totalCount: number;
  /** Items with `card === null`. Only ever non-zero for managers; the target is never partly sighted. */
  hiddenCount: number;
  canReorder: boolean;
  /** Workspaces where this viewer may add/move/remove. Mirrors `separatorWorkspaceIds`. */
  reorderableWorkspaceIds: string[];
};
