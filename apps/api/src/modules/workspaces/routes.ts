import { dto } from "@kanera/shared";
import { boards, workspaces } from "@kanera/shared/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assertOrgRole, assertWorkspaceAccess } from "../../lib/access.js";
import { requestLocale } from "../../lib/i18n/request-locale.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { assertGuestsAllowed } from "../../lib/tier-limits.js";
import { deleteWorkspaceCascade } from "../../lib/workspace-delete.js";
import { emitToWorkspace } from "../../realtime/emit.js";
import { disconnectUserRealtimeSockets } from "../../realtime/io.js";
import { createWorkspace, emitCreateWorkspace } from "./create-workspace.js";
import { loadHomeBoardDirectory } from "./home-directory.js";
import { toWireWorkspace } from "./route-support.js";
import { emitUpdateWorkspace, updateWorkspace } from "./update-workspace.js";
import {
  emitInviteWorkspaceGuest,
  emitRemoveWorkspaceGuest,
  inviteWorkspaceGuest,
  previewGuestInvitationSeat,
  removeWorkspaceGuest,
  revokeWorkspaceGuestInvitation,
} from "./workspace-guests.js";
import {
  addWorkspaceMember,
  emitAddWorkspaceMember,
  emitRemoveWorkspaceMember,
  removeWorkspaceMember,
  updateWorkspaceMemberRole,
} from "./workspace-members.js";
import {
  listWorkspaceGuests,
  listWorkspaceMemberCandidates,
  listWorkspaceMembers,
  listWorkspaces,
  loadWorkspaceSettings,
} from "./workspace-queries.js";

interface WorkspaceRouteOptions {
  exposeHomeBoardDirectory?: boolean;
}

// Each handler validates input, authorizes, calls one use case and then emits. Validation and
// authorization keep their historical order per route so error precedence is unchanged.
export async function workspaceRoutes(app: FastifyInstance, options: WorkspaceRouteOptions = {}) {
  app.addHook("preHandler", app.authenticate);

  app.get("/workspaces", async (req) => {
    const directory = dto.agentDirectoryQuery.parse(req.query ?? {});
    return listWorkspaces({ auth: req.auth, directory });
  });

  app.post("/workspaces", async (req, reply) => {
    assertOrgRole(req.auth, "admin");
    const body = dto.createWorkspaceBody.parse(req.body);
    const result = await createWorkspace({ auth: req.auth, body });
    await emitCreateWorkspace({ auth: req.auth, ...result });
    const { workspace: ws, initialBoard } = result;
    const publicWorkspace = toWireWorkspace(ws);
    return reply.status(201).send(initialBoard ? { ...publicWorkspace, initialBoard } : publicWorkspace);
  });

  app.get("/workspaces/:id", async (req) => {
    const { id } = req.params as { id: string };
    const { role } = await assertWorkspaceAccess(req.auth, id);
    return loadWorkspaceSettings({ auth: req.auth, workspaceId: id, role });
  });

  app.patch("/workspaces/:id", async (req) => {
    const { id } = req.params as { id: string };
    await assertWorkspaceAccess(req.auth, id, "admin");
    const body = dto.updateWorkspaceBody.parse(req.body);
    const result = await updateWorkspace({ auth: req.auth, workspaceId: id, body });
    const publicWorkspace = toWireWorkspace(result.workspace);
    await emitUpdateWorkspace({ ...result, workspaceId: id, publicWorkspace });
    return publicWorkspace;
  });

  app.delete("/workspaces/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = dto.deleteWorkspaceBody.parse(req.body);
    const { clientId } = await assertWorkspaceAccess(req.auth, id, "admin");
    const [workspace] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (!workspace) throw notFound("workspace not found");
    if (body.confirmationName !== workspace.name) throw badRequest("workspace name does not match");

    await deleteWorkspaceCascade({ workspaceId: id, clientId });
    return reply.status(204).send();
  });

  app.get("/workspaces/:id/members", async (req) => {
    const { id } = req.params as { id: string };
    const directory = dto.agentDirectoryQuery.parse(req.query ?? {});
    const { clientId } = await assertWorkspaceAccess(req.auth, id);
    return listWorkspaceMembers({ workspaceId: id, clientId, directory });
  });

  app.get("/workspaces/:id/member-candidates", async (req) => {
    const { id } = req.params as { id: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, id, "admin");
    return listWorkspaceMemberCandidates({ clientId });
  });

  app.post("/workspaces/:id/members", async (req) => {
    const { id } = req.params as { id: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, id, "admin");
    const body = dto.addWorkspaceMemberBody.parse(req.body);
    const payload = await addWorkspaceMember({ auth: req.auth, workspaceId: id, clientId, body });
    await emitAddWorkspaceMember({ auth: req.auth, workspaceId: id, clientId, userId: body.userId, payload });
    return payload;
  });

  app.patch("/workspaces/:id/members/:userId", async (req) => {
    const { id, userId } = req.params as { id: string; userId: string };
    if (userId === req.auth.sub) throw badRequest("cannot change your own role");
    await assertWorkspaceAccess(req.auth, id, "admin");
    const body = dto.updateWorkspaceMemberBody.parse(req.body);
    const member = await updateWorkspaceMemberRole({ auth: req.auth, workspaceId: id, userId, body });
    await emitToWorkspace(id, "workspace:member:updated", { workspaceId: id, member });
    disconnectUserRealtimeSockets(userId);
    return member;
  });

  app.delete("/workspaces/:id/members/:userId", async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    if (userId === req.auth.sub) throw badRequest("cannot remove yourself");
    await assertWorkspaceAccess(req.auth, id, "admin");
    const cleanup = await removeWorkspaceMember({ auth: req.auth, workspaceId: id, userId });
    await emitRemoveWorkspaceMember({ workspaceId: id, userId, cleanup });
    return reply.status(204).send();
  });

  app.get("/workspaces/:id/boards", async (req) => {
    const { id } = req.params as { id: string };
    const directory = dto.agentDirectoryQuery.parse(req.query ?? {});
    await assertWorkspaceAccess(req.auth, id);
    const rows = await db.select().from(boards).where(and(eq(boards.workspaceId, id), isNull(boards.archivedAt))).orderBy(asc(boards.position));
    return directory.limit === undefined ? rows : rows.slice(directory.offset, directory.offset + directory.limit);
  });

  app.get("/workspaces/:id/guests", async (req) => {
    const { id } = req.params as { id: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, id, "admin");
    return listWorkspaceGuests({ workspaceId: id, clientId });
  });

  app.post("/workspaces/:id/guests/seat-preview", async (req) => {
    const { id } = req.params as { id: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, id, "admin");
    await assertGuestsAllowed(clientId);
    const raw = req.body as { boardId?: unknown; email?: unknown } | null;
    if (!raw || typeof raw.boardId !== "string") throw badRequest("boardId is required");
    const body = dto.createBoardInvitationBody.parse(req.body);
    return previewGuestInvitationSeat({ workspaceId: id, clientId, boardId: raw.boardId, body });
  });

  app.post("/workspaces/:id/guests/invitations", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, id, "admin");
    // Free-tier hosted orgs cannot use guests at all. Paid/trial/self-hosted fall through to the
    // per-org guest board allowance below.
    await assertGuestsAllowed(clientId);
    const raw = req.body as { boardId?: unknown } | null;
    if (!raw || typeof raw.boardId !== "string") throw badRequest("boardId is required");
    const body = dto.createBoardInvitationBody.parse(req.body);
    const result = await inviteWorkspaceGuest({ auth: req.auth, workspaceId: id, clientId, boardId: raw.boardId, body });
    await emitInviteWorkspaceGuest({ auth: req.auth, mailer: app.mailer, locale: requestLocale(req), result });
    return reply.status(201).send(result.response);
  });

  app.delete("/workspaces/:id/guests/invitations/:invitationId", async (req, reply) => {
    const { id, invitationId } = req.params as { id: string; invitationId: string };
    await assertWorkspaceAccess(req.auth, id, "admin");
    await revokeWorkspaceGuestInvitation({ workspaceId: id, invitationId });
    return reply.status(204).send();
  });

  app.delete("/workspaces/:id/guests/:boardId/:userId", async (req, reply) => {
    const { id, boardId, userId } = req.params as { id: string; boardId: string; userId: string };
    const { clientId } = await assertWorkspaceAccess(req.auth, id, "admin");
    const { cleanup, guestSeat } = await removeWorkspaceGuest({ auth: req.auth, workspaceId: id, clientId, boardId, userId });
    await emitRemoveWorkspaceGuest({ boardId, userId, cleanup });
    return reply.status(200).send({ paidGuestSeatRemoved: guestSeat.paidGuestSeatRemoved });
  });

  // The web app retains its home-shaped route. Public integrations use the board directory route,
  // keeping app navigation concepts out of the external contract.
  if (options.exposeHomeBoardDirectory ?? true) app.get("/home/boards", async (req) => loadHomeBoardDirectory({ auth: req.auth }));
}
