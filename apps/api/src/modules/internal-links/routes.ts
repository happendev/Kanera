import { dto } from "@kanera/shared";
import type { ResolveInternalLinksResponse, ResolvedInternalLink } from "@kanera/shared/dto";
import { boards, cards, externalLinks, lists, notes } from "@kanera/shared/schema";
import { and, eq, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assertBoardAccess } from "../../lib/access.js";
import { canReadNote, parseInternalUrl } from "../../lib/internal-links.js";

const MAX_URLS = 50;

async function canResolveThroughAccessibleMirror(auth: Parameters<typeof assertBoardAccess>[0], sourceCardId: string): Promise<boolean> {
  const mirroredTargets = await db
    .selectDistinct({ boardId: cards.boardId })
    .from(externalLinks)
    .innerJoin(cards, eq(cards.id, externalLinks.entityId))
    .where(and(
      eq(externalLinks.externalType, "card"),
      eq(externalLinks.externalId, sourceCardId),
      eq(externalLinks.entityType, "card"),
      like(externalLinks.provider, "mirror:%"),
    ));
  for (const target of mirroredTargets) {
    try {
      await assertBoardAccess(auth, target.boardId);
      return true;
    } catch {
      // Try every linked destination without revealing inaccessible mirror targets.
    }
  }
  return false;
}

export async function internalLinkRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post("/internal-links/resolve", async (req): Promise<ResolveInternalLinksResponse> => {
    const body = dto.resolveInternalLinksBody.parse(req.body);
    const uniqueUrls = [...new Set(body.urls)].slice(0, MAX_URLS);
    const links: Record<string, ResolvedInternalLink> = {};

    await Promise.all(uniqueUrls.map(async (raw) => {
      const parsed = parseInternalUrl(raw);
      if (!parsed) return;

      try {
        if (parsed.kind === "board") {
          await assertBoardAccess(req.auth, parsed.boardId);
          const [board] = await db
            .select({ id: boards.id, name: boards.name, icon: boards.icon, iconColor: boards.iconColor })
            .from(boards)
            .where(eq(boards.id, parsed.boardId))
            .limit(1);
          if (!board) return;
          links[raw] = {
            kind: "board",
            title: board.name,
            boardId: board.id,
            icon: board.icon,
            iconColor: board.iconColor,
            href: parsed.href,
          };
          return;
        }

        if (parsed.kind === "note") {
          const [row] = await db
            .select({
              id: notes.id,
              title: notes.title,
              workspaceId: notes.workspaceId,
              boardId: notes.boardId,
              scope: notes.scope,
              ownerId: notes.ownerId,
              icon: notes.icon,
              color: notes.color,
              boardName: boards.name,
            })
            .from(notes)
            .leftJoin(boards, eq(boards.id, notes.boardId))
            .where(eq(notes.id, parsed.noteId))
            .limit(1);
          if (!row) return;
          if (parsed.boardId && row.boardId !== parsed.boardId) return;
          if (!parsed.boardId && parsed.workspaceId && row.workspaceId !== parsed.workspaceId) return;
          if (!await canReadNote(req.auth, row)) return;
          links[raw] = {
            kind: "note",
            title: row.title,
            noteId: row.id,
            workspaceId: row.workspaceId,
            boardId: row.boardId,
            boardName: row.boardName,
            scope: row.scope,
            icon: row.icon,
            color: row.color,
            href: parsed.href,
          };
          return;
        }

        try {
          await assertBoardAccess(req.auth, parsed.boardId);
        } catch {
          // A mirror provenance comment intentionally links back to its source. Allow the rich
          // card preview when this viewer can access a live destination card linked to that source;
          // arbitrary inaccessible card URLs remain unresolved.
          if (!await canResolveThroughAccessibleMirror(req.auth, parsed.cardId)) return;
        }

        const [row] = await db
          .select({
            cardId: cards.id,
            title: cards.title,
            boardId: boards.id,
            boardName: boards.name,
            boardIcon: boards.icon,
            boardIconColor: boards.iconColor,
            listName: lists.name,
          })
          .from(cards)
          .innerJoin(boards, eq(boards.id, cards.boardId))
          .innerJoin(lists, eq(lists.id, cards.listId))
          .where(and(eq(cards.id, parsed.cardId), eq(cards.boardId, parsed.boardId)))
          .limit(1);
        if (!row) return;

        links[raw] = {
          kind: "card",
          title: row.title,
          boardName: row.boardName,
          listName: row.listName,
          boardId: row.boardId,
          boardIcon: row.boardIcon,
          boardIconColor: row.boardIconColor,
          cardId: row.cardId,
          href: parsed.href,
        };
      } catch {
        // Do not reveal whether private, deleted, or malformed internal targets exist.
      }
    }));

    return { links };
  });
}
