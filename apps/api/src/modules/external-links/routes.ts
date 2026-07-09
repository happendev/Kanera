import { dto } from "@kanera/shared";
import { boards, cardAttachments, cardChecklistItems, cardChecklists, cards, comments, externalLinks } from "@kanera/shared/schema";
import { and, desc, eq, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assertWorkspaceAccess } from "../../lib/access.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";

async function assertExternalLinkWriteAccess(
  req: Parameters<FastifyInstance["authenticate"]>[0],
  workspaceId: string,
) {
  if (req.auth.authKind === "apiKey") {
    // External links are integration-maintained sync metadata: write-scoped API keys may mutate
    // them, while human users still need workspace-admin power because this is workspace-scoped.
    await assertWorkspaceAccess(req.auth, workspaceId);
    if ((req.auth.apiKeyScope ?? "read") === "read") throw forbidden();
    return;
  }

  await assertWorkspaceAccess(req.auth, workspaceId, "admin");
}

async function assertEntityBelongsToWorkspace(
  workspaceId: string,
  entityType: dto.ExternalLinkEntityType,
  entityId: string,
) {
  if (entityType === "card") {
    const [row] = await db
      .select({ id: cards.id })
      .from(cards)
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .where(and(eq(cards.id, entityId), eq(boards.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw badRequest("entityId is not a card in this workspace");
    return;
  }

  if (entityType === "comment") {
    const [row] = await db
      .select({ id: comments.id })
      .from(comments)
      .innerJoin(cards, eq(cards.id, comments.cardId))
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .where(and(eq(comments.id, entityId), eq(boards.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw badRequest("entityId is not a comment in this workspace");
    return;
  }

  if (entityType === "cardAttachment") {
    const [row] = await db
      .select({ id: cardAttachments.id })
      .from(cardAttachments)
      .innerJoin(cards, eq(cards.id, cardAttachments.cardId))
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .where(and(eq(cardAttachments.id, entityId), eq(boards.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw badRequest("entityId is not an attachment in this workspace");
    return;
  }

  if (entityType === "cardChecklist") {
    const [row] = await db
      .select({ id: cardChecklists.id })
      .from(cardChecklists)
      .innerJoin(cards, eq(cards.id, cardChecklists.cardId))
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .where(and(eq(cardChecklists.id, entityId), eq(boards.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw badRequest("entityId is not a checklist in this workspace");
    return;
  }

  if (entityType === "cardChecklistItem") {
    const [row] = await db
      .select({ id: cardChecklistItems.id })
      .from(cardChecklistItems)
      .innerJoin(cardChecklists, eq(cardChecklists.id, cardChecklistItems.checklistId))
      .innerJoin(cards, eq(cards.id, cardChecklists.cardId))
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .where(and(eq(cardChecklistItems.id, entityId), eq(boards.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw badRequest("entityId is not a checklist item in this workspace");
    return;
  }
}

export async function externalLinkRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/workspaces/:id/external-links", async (req): Promise<dto.ExternalLinkRow[]> => {
    const { id: workspaceId } = req.params as { id: string };
    const query = dto.listExternalLinksQuery.parse(req.query ?? {});
    await assertWorkspaceAccess(req.auth, workspaceId);

    const conditions: SQL[] = [eq(externalLinks.workspaceId, workspaceId)];
    if (query.provider !== undefined) conditions.push(eq(externalLinks.provider, query.provider));
    if (query.externalType !== undefined) conditions.push(eq(externalLinks.externalType, query.externalType));
    if (query.externalId !== undefined) conditions.push(eq(externalLinks.externalId, query.externalId));
    if (query.entityType !== undefined) conditions.push(eq(externalLinks.entityType, query.entityType));
    if (query.entityId !== undefined) conditions.push(eq(externalLinks.entityId, query.entityId));

    return db
      .select()
      .from(externalLinks)
      .where(and(...conditions))
      .orderBy(desc(externalLinks.updatedAt))
      .limit(query.limit);
  });

  app.get("/workspaces/:workspaceId/external-links/:linkId", async (req): Promise<dto.ExternalLinkRow> => {
    const { workspaceId, linkId } = req.params as { workspaceId: string; linkId: string };
    await assertWorkspaceAccess(req.auth, workspaceId);
    const [row] = await db
      .select()
      .from(externalLinks)
      .where(and(eq(externalLinks.id, linkId), eq(externalLinks.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw notFound("external link not found");
    return row;
  });

  app.post("/workspaces/:id/external-links", async (req): Promise<dto.ExternalLinkRow> => {
    const { id: workspaceId } = req.params as { id: string };
    const body = dto.upsertExternalLinkBody.parse(req.body);
    await assertExternalLinkWriteAccess(req, workspaceId);
    await assertEntityBelongsToWorkspace(workspaceId, body.entityType, body.entityId);

    const now = new Date();
    const [row] = await db
      .insert(externalLinks)
      .values({ workspaceId, ...body, updatedAt: now })
      .onConflictDoUpdate({
        target: [
          externalLinks.workspaceId,
          externalLinks.provider,
          externalLinks.externalType,
          externalLinks.externalId,
        ],
        set: {
          entityType: body.entityType,
          entityId: body.entityId,
          updatedAt: now,
        },
      })
      .returning();
    return row!;
  });

  app.delete("/workspaces/:workspaceId/external-links/:linkId", async (req, reply) => {
    const { workspaceId, linkId } = req.params as { workspaceId: string; linkId: string };
    await assertExternalLinkWriteAccess(req, workspaceId);
    const [row] = await db
      .delete(externalLinks)
      .where(and(eq(externalLinks.id, linkId), eq(externalLinks.workspaceId, workspaceId)))
      .returning({ id: externalLinks.id });
    if (!row) throw notFound("external link not found");
    return reply.status(204).send();
  });
}
