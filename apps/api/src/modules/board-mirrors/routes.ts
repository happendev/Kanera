import { dto } from "@kanera/shared";
import { SERVER_EVENTS } from "@kanera/shared/events";
import type { FastifyInstance } from "fastify";
import { assertBoardAccess, assertBoardManageAccess, assertCardAccess, assertWorkspaceAccess } from "../../lib/access.js";
import { resolveBoardMirrorAccess } from "../../lib/board-mirror/access.js";
import { badRequest, forbidden } from "../../lib/errors.js";
import { assertBoardSyncAllowed } from "../../lib/tier-limits.js";
import { createMirror } from "./create-mirror.js";
import { deleteMirror } from "./delete-mirror.js";
import {
  listMirrorSourceBoards,
  listMirrorTargetBoards,
  loadBoardMirrors,
  loadBoardMirrorStatus,
  loadCardMirrorStatus,
  loadMirrorRows,
  loadWorkspaceMirrorStatus,
} from "./mirror-queries.js";
import { disableMirrorSource, enableMirrorSource } from "./mirror-source-state.js";
import {
  assertMirrorCapability,
  emitMirrorDeletedToBoards,
  emitMirrorEntityToBoards,
  loadManagedMirror,
  normalizeListMappings,
} from "./route-support.js";
import { updateMirror } from "./update-mirror.js";

export async function boardMirrorRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/workspaces/:workspaceId/mirror-status", async (req): Promise<{ count: number }> => {
    const { workspaceId } = dto.uuidParams("workspaceId").parse(req.params);
    await assertWorkspaceAccess(req.auth, workspaceId, "admin");
    return loadWorkspaceMirrorStatus(workspaceId);
  });

  app.get("/boards/:boardId/mirror-status", async (req): Promise<dto.BoardMirrorStatus> => {
    const { boardId } = dto.uuidParams("boardId").parse(req.params);
    await assertBoardAccess(req.auth, boardId);
    return loadBoardMirrorStatus(req.auth, boardId);
  });

  app.post("/boards/:boardId/mirrors", async (req, reply) => {
    const { boardId: sourceBoardId } = dto.uuidParams("boardId").parse(req.params);
    const body = dto.createBoardMirrorBody.parse(req.body);
    const sourceCtx = await assertBoardAccess(req.auth, sourceBoardId, "editor");
    // The mirror worker copies every card in the mapped lists with system authority. A member
    // limited to their assigned items must not be able to export the rest of the board through it.
    if (sourceCtx.assignedItemsOnly) throw forbidden();
    const targetCtx = await assertBoardManageAccess(req.auth, body.targetBoardId);
    if (sourceBoardId === body.targetBoardId) throw badRequest("a board cannot mirror itself");
    const mappings = await normalizeListMappings(body.lists, sourceCtx.workspaceId, targetCtx.workspaceId);

    const mirror = await createMirror({ auth: req.auth, sourceBoardId, targetBoardId: body.targetBoardId, sourceCtx, targetCtx, mappings });
    const [response] = await loadMirrorRows([mirror.id], req.auth);
    await emitMirrorEntityToBoards(SERVER_EVENTS.BOARD_MIRROR_CREATED, response!);
    return reply.status(201).send(response!);
  });

  app.get("/boards/:boardId/mirrors", async (req): Promise<dto.BoardMirrorRow[]> => {
    const { boardId } = dto.uuidParams("boardId").parse(req.params);
    await assertBoardAccess(req.auth, boardId, "editor");
    return loadBoardMirrors(req.auth, boardId, "inbound");
  });

  app.get("/boards/:boardId/outbound-mirrors", async (req): Promise<dto.BoardMirrorRow[]> => {
    const { boardId } = dto.uuidParams("boardId").parse(req.params);
    await assertBoardAccess(req.auth, boardId, "editor");
    return loadBoardMirrors(req.auth, boardId, "outbound");
  });

  app.patch("/boards/:boardId/mirrors/:mirrorId", async (req): Promise<dto.BoardMirrorRow> => {
    const { boardId, mirrorId } = dto.uuidParams("boardId", "mirrorId").parse(req.params);
    const body = dto.updateBoardMirrorBody.parse(req.body);
    await assertBoardAccess(req.auth, boardId, "editor");
    const mirror = await loadManagedMirror(mirrorId, boardId);
    // Pausing is target-owned governance. The source may change which of its lists feed the
    // established relationship, but must use its independent enable/disable control for syncing.
    if (body.paused !== undefined) await assertMirrorCapability(req.auth, mirror, "target");
    if (body.lists !== undefined) await assertMirrorCapability(req.auth, mirror, "either");
    if (body.paused === false) {
      const access = await resolveBoardMirrorAccess(req.auth, mirror);
      await assertBoardSyncAllowed([access.sourceClientId, access.targetClientId]);
    }
    const mappings = body.lists
      ? await normalizeListMappings(body.lists, mirror.sourceWorkspaceId, mirror.targetWorkspaceId)
      : null;
    await updateMirror({ auth: req.auth, mirror, body, mappings });
    const response = (await loadMirrorRows([mirror.id], req.auth))[0]!;
    await emitMirrorEntityToBoards(SERVER_EVENTS.BOARD_MIRROR_UPDATED, response);
    return response;
  });

  app.post("/boards/:boardId/mirrors/:mirrorId/source-disable", async (req) => {
    const { boardId, mirrorId } = dto.uuidParams("boardId", "mirrorId").parse(req.params);
    await assertBoardAccess(req.auth, boardId, "editor");
    const mirror = await loadManagedMirror(mirrorId, boardId);
    await assertMirrorCapability(req.auth, mirror, "source");
    await disableMirrorSource({ auth: req.auth, mirror });
    const response = (await loadMirrorRows([mirror.id], req.auth))[0]!;
    await emitMirrorEntityToBoards(SERVER_EVENTS.BOARD_MIRROR_UPDATED, response);
    return { ok: true };
  });

  app.post("/boards/:boardId/mirrors/:mirrorId/source-enable", async (req) => {
    const { boardId, mirrorId } = dto.uuidParams("boardId", "mirrorId").parse(req.params);
    await assertBoardAccess(req.auth, boardId, "editor");
    const mirror = await loadManagedMirror(mirrorId, boardId);
    await assertMirrorCapability(req.auth, mirror, "source");
    const access = await resolveBoardMirrorAccess(req.auth, mirror);
    await assertBoardSyncAllowed([access.sourceClientId, access.targetClientId]);
    await enableMirrorSource({ auth: req.auth, mirror });
    const response = (await loadMirrorRows([mirror.id], req.auth))[0]!;
    await emitMirrorEntityToBoards(SERVER_EVENTS.BOARD_MIRROR_UPDATED, response);
    return { ok: true };
  });

  app.delete("/boards/:boardId/mirrors/:mirrorId", async (req, reply) => {
    const { boardId, mirrorId } = dto.uuidParams("boardId", "mirrorId").parse(req.params);
    await assertBoardAccess(req.auth, boardId, "editor");
    // Either participating board may end the relationship; deleting the durable link leaves the
    // already-created target cards intact, regardless of which side initiated the removal.
    const mirror = await loadManagedMirror(mirrorId, boardId);
    await assertMirrorCapability(req.auth, mirror, "either");
    await deleteMirror({ auth: req.auth, mirror });
    await emitMirrorDeletedToBoards(mirror);
    return reply.status(204).send();
  });

  app.get("/cards/:id/mirrors", async (req): Promise<dto.CardMirrorStatus> => {
    const { id } = dto.uuidParams("id").parse(req.params);
    await assertCardAccess(req.auth, id);
    return loadCardMirrorStatus(req.auth, id);
  });

  app.get("/mirror-target-boards", async (req): Promise<dto.MirrorTargetBoardsResponse> => {
    const { sourceBoardId } = dto.mirrorTargetBoardsQuery.parse(req.query);
    const sourceCtx = await assertBoardAccess(req.auth, sourceBoardId, "editor");
    if (sourceCtx.assignedItemsOnly) throw forbidden();
    await assertBoardSyncAllowed([sourceCtx.clientId]);
    return listMirrorTargetBoards(req.auth, sourceBoardId);
  });

  app.get("/mirror-source-boards", async (req): Promise<dto.MirrorSourceBoardsResponse> => {
    const { targetBoardId } = dto.mirrorSourceBoardsQuery.parse(req.query);
    const targetCtx = await assertBoardManageAccess(req.auth, targetBoardId);
    await assertBoardSyncAllowed([targetCtx.clientId]);
    return listMirrorSourceBoards(req.auth, targetBoardId);
  });
}
