import type { dto } from "@kanera/shared";
import type { WireCard } from "@kanera/shared/events";
import type { cards } from "@kanera/shared/schema";
import type { AuthClaims } from "../../auth/plugin.js";
import type { assertBoardAccess, assertCardAccess } from "../../lib/access.js";
import { positionForLaneInsert, rebalanceBoardLane } from "../../lib/board-lane.js";
import { duplicateCardInto, emitDuplicatedCardIntoBoard, resolveDuplicateTargetList } from "./duplicate-card.js";
import { topPositionForList } from "./route-support.js";

type BoardAccessContext = Awaited<ReturnType<typeof assertBoardAccess>>;
type CardAccessContext = Awaited<ReturnType<typeof assertCardAccess>>;
type DuplicatedCard = Awaited<ReturnType<typeof duplicateCardInto>>;

async function bottomPositionForList(boardId: string, listId: string): Promise<string> {
  return (await positionForLaneInsert({ boardId, listId, beforeItem: null })).position;
}

/** Duplicates one card for the single-card duplicate route, placing it by the request's target. */
export async function duplicateCard({
  auth,
  source,
  srcCtx,
  dstCtx,
  body,
}: {
  auth: AuthClaims;
  source: typeof cards.$inferSelect;
  srcCtx: CardAccessContext;
  dstCtx: BoardAccessContext;
  body: dto.DuplicateCardBody;
}) {
  const targetBoardId = body.boardId ?? source.boardId;
  const targetListId = await resolveDuplicateTargetList(source, dstCtx, body.listId);

  let position: string;
  let needsRebalance = false;
  if (targetBoardId === source.boardId && targetListId === source.listId) {
    // Duplicating in place inserts a new card directly after the source; the source itself is
    // not moving, so it must stay in the lane to serve as the `afterItem` anchor (passing
    // `moving` here would filter it out and the anchor lookup would fail).
    const result = await positionForLaneInsert({
      boardId: targetBoardId,
      listId: targetListId,
      afterItem: { type: "card", id: source.id },
    });
    position = result.position;
    needsRebalance = result.needsRebalance;
  } else if (targetBoardId !== source.boardId || body.atTop) {
    position = await topPositionForList(targetBoardId, targetListId);
  } else {
    position = await bottomPositionForList(targetBoardId, targetListId);
  }

  const duplicated = await duplicateCardInto({
    source,
    srcCtx,
    dstCtx,
    targetBoardId,
    targetListId,
    position,
    actor: auth,
    bulk: false,
  });

  const rebalancedPositions = needsRebalance ? await rebalanceBoardLane(targetListId, targetBoardId) : null;
  return { targetListId, duplicated, rebalancedPositions };
}

/** Duplicates one card of a bulk duplicate to the bottom of its resolved target list. */
export async function duplicateCardForBulk({
  auth,
  source,
  srcCtx,
  dstCtx,
  targetBoardId,
  listId,
}: {
  auth: AuthClaims;
  source: typeof cards.$inferSelect;
  srcCtx: BoardAccessContext;
  dstCtx: BoardAccessContext;
  targetBoardId: string;
  listId: string | undefined;
}): Promise<DuplicatedCard> {
  const targetListId = await resolveDuplicateTargetList(source, dstCtx, listId);
  const position = await bottomPositionForList(targetBoardId, targetListId);
  return duplicateCardInto({
    source,
    srcCtx,
    dstCtx,
    targetBoardId,
    targetListId,
    position,
    actor: auth,
    bulk: true,
  });
}

export async function emitCardDuplicate({
  auth,
  boardId,
  duplicated,
}: {
  auth: AuthClaims;
  boardId: string;
  duplicated: DuplicatedCard;
}): Promise<WireCard> {
  return emitDuplicatedCardIntoBoard({
    actor: auth,
    boardId,
    card: duplicated.newCard,
    activity: duplicated.activity,
    labelIds: duplicated.labelIds,
    assigneeIds: duplicated.assigneeIds,
    customFieldValues: duplicated.customFieldValues,
    attachmentRows: duplicated.attachmentRows,
  });
}
