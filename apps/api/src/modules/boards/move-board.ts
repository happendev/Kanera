import type { MoveBoardBody } from "@kanera/shared/dto";
import { boards } from "@kanera/shared/schema";
import type { AuthClaims } from "../../auth/plugin.js";
import { moveOrderedEntity } from "../../lib/move-ordered-entity.js";
import { workspaceNeighbourPositions } from "../../lib/position.js";
import { rebalanceBoards } from "../../lib/rebalance.js";
import { emitBoardRebalancedToVisibleUsers, emitToBoardAudience } from "../../realtime/emit.js";

// Reorder requests only need the anchor and its immediate neighbor. Keep this
// as targeted indexed probes so large workspaces do not pay for a full board scan.
const neighbourPositions = workspaceNeighbourPositions(boards, "Board");

type MovedBoard = Awaited<ReturnType<typeof moveBoard>>;

export async function moveBoard({
  auth,
  current,
  body,
}: {
  auth: AuthClaims;
  current: typeof boards.$inferSelect;
  body: MoveBoardBody;
}) {
  const id = current.id;
  const prevPosition = current.position;
  const { position, rebalancedPositions } = await moveOrderedEntity({
    table: boards,
    idColumn: boards.id,
    id,
    neighbours: await neighbourPositions(current.workspaceId, body.afterBoardId, body.beforeBoardId),
    rebalance: (tx) => rebalanceBoards(current.workspaceId, tx),
    activity: (position) => ({
      boardId: id,
      workspaceId: current.workspaceId,
      actorId: auth.sub,
      entityType: "board",
      entityId: id,
      action: "moved",
      payload: { prevPosition, position },
    }),
  });
  return { id, workspaceId: current.workspaceId, prevPosition, position, rebalancedPositions };
}

export async function emitBoardMoved({ id, workspaceId, prevPosition, position, rebalancedPositions }: MovedBoard) {
  if (rebalancedPositions) {
    await emitBoardRebalancedToVisibleUsers(workspaceId, { workspaceId, positions: rebalancedPositions });
  }
  await emitToBoardAudience(id, "board:moved", {
    workspaceId,
    boardId: id,
    position,
    prevPosition,
  }, { workspaceId });
}
