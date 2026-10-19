import { dto } from "@kanera/shared";
import type { PlanUsageResponse, StorageFileRow, StorageOverviewResponse } from "@kanera/shared/dto";
import {
  boards,
  cardAttachments,
  cards,
  noteAttachments,
  notes,
  scratchpadNoteAttachments,
  users,
  workspaces,
} from "@kanera/shared/schema";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assertCardAccess, assertOrgRole } from "../../lib/access.js";
import { getUploadEntitlements } from "../../lib/entitlements.js";
import { getPlanUsage } from "../../lib/tier-limits.js";
import { emitClientEntitlementsChanged } from "../../realtime/emit.js";
import { removeCardAttachment } from "../cards/attachments.routes.js";
import { removeNoteAttachment } from "../notes/routes.js";

type Totals = { bytes: number; count: number };

const totalsColumns = (byteSize: typeof cardAttachments.byteSize | typeof noteAttachments.byteSize | typeof scratchpadNoteAttachments.byteSize) => ({
  bytes: sql<string>`coalesce(sum(${byteSize}), 0)::bigint`,
  count: sql<number>`count(*)::int`,
});

function toTotals(row: { bytes: string | number; count: number } | undefined): Totals {
  return { bytes: Number(row?.bytes ?? 0), count: row?.count ?? 0 };
}

/**
 * Card attachments and team-note attachments the organisation pays for, as one listing. Personal
 * notes and scratchpads are private to their owners, so they are counted in the overview but never
 * listed here, and an admin cannot delete them from this tool.
 */
function storageFilesSource(clientId: string): SQL {
  return sql`
    select 'card' as kind, ${cardAttachments.id} as id, ${cardAttachments.fileName} as file_name,
      ${cardAttachments.mimeType} as mime_type, ${cardAttachments.byteSize} as byte_size,
      ${cardAttachments.createdAt} as created_at, ${users.displayName} as uploaded_by_name,
      ${workspaces.id} as workspace_id, ${workspaces.name} as workspace_name, ${workspaces.kind} as workspace_kind,
      ${boards.id} as board_id, ${boards.name} as board_name,
      ${cards.id} as card_id, ${cards.key} as card_key, ${cards.organisationKey} as organisation_key,
      ${cards.title} as card_title, null::uuid as note_id, null::text as note_title,
      (${cards.archivedAt} is not null or ${boards.archivedAt} is not null) as archived
    from ${cardAttachments}
    inner join ${cards} on ${cards.id} = ${cardAttachments.cardId}
    inner join ${boards} on ${boards.id} = ${cards.boardId}
    inner join ${workspaces} on ${workspaces.id} = ${cards.workspaceId}
    inner join ${users} on ${users.id} = ${cardAttachments.uploadedById}
    where ${cardAttachments.clientId} = ${clientId}
    union all
    select 'note', ${noteAttachments.id}, ${noteAttachments.fileName}, ${noteAttachments.mimeType},
      ${noteAttachments.byteSize}, ${noteAttachments.createdAt}, ${users.displayName},
      ${workspaces.id}, ${workspaces.name}, ${workspaces.kind}, ${boards.id}, ${boards.name},
      null, null, null, null, ${notes.id}, ${notes.title},
      coalesce(${boards.archivedAt} is not null, false)
    from ${noteAttachments}
    inner join ${notes} on ${notes.id} = ${noteAttachments.noteId}
    inner join ${workspaces} on ${workspaces.id} = ${notes.workspaceId}
    left join ${boards} on ${boards.id} = ${notes.boardId}
    inner join ${users} on ${users.id} = ${noteAttachments.uploadedById}
    where ${noteAttachments.clientId} = ${clientId} and ${notes.scope} = 'team'
  `;
}

type StorageFileDbRow = {
  kind: StorageFileRow["kind"];
  id: string;
  file_name: string;
  mime_type: string;
  byte_size: string | number;
  created_at: string | Date;
  uploaded_by_name: string;
  workspace_id: string;
  workspace_name: string;
  workspace_kind: StorageFileRow["workspaceKind"];
  board_id: string | null;
  board_name: string | null;
  card_id: string | null;
  card_key: string | null;
  organisation_key: string | null;
  card_title: string | null;
  note_id: string | null;
  note_title: string | null;
  archived: boolean;
};

export async function clientStorageRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Hosted plan meters (boards, members/seats, automations) beside the storage pool. Same admin gate
  // as the storage overview: usage is organisation-wide and sits next to billing.
  app.get("/clients/me/plan-usage", async (req): Promise<PlanUsageResponse> => {
    assertOrgRole(req.auth, "admin");
    return getPlanUsage(req.auth.cid);
  });

  app.get("/clients/me/storage", async (req): Promise<StorageOverviewResponse> => {
    assertOrgRole(req.auth, "admin");
    const clientId = req.auth.cid;

    const [entitlements, [cardTotals], [teamNoteTotals], [personalNoteTotals], [scratchpadTotals], cardsByWorkspace, notesByWorkspace] = await Promise.all([
      getUploadEntitlements(db, clientId),
      db.select(totalsColumns(cardAttachments.byteSize)).from(cardAttachments).where(eq(cardAttachments.clientId, clientId)),
      db.select(totalsColumns(noteAttachments.byteSize)).from(noteAttachments)
        .innerJoin(notes, eq(notes.id, noteAttachments.noteId))
        .where(and(eq(noteAttachments.clientId, clientId), eq(notes.scope, "team"))),
      db.select(totalsColumns(noteAttachments.byteSize)).from(noteAttachments)
        .innerJoin(notes, eq(notes.id, noteAttachments.noteId))
        .where(and(eq(noteAttachments.clientId, clientId), eq(notes.scope, "personal"))),
      db.select(totalsColumns(scratchpadNoteAttachments.byteSize)).from(scratchpadNoteAttachments).where(eq(scratchpadNoteAttachments.clientId, clientId)),
      db.select({ workspaceId: cards.workspaceId, ...totalsColumns(cardAttachments.byteSize) })
        .from(cardAttachments)
        .innerJoin(cards, eq(cards.id, cardAttachments.cardId))
        .where(eq(cardAttachments.clientId, clientId))
        .groupBy(cards.workspaceId),
      db.select({ workspaceId: notes.workspaceId, ...totalsColumns(noteAttachments.byteSize) })
        .from(noteAttachments)
        .innerJoin(notes, eq(notes.id, noteAttachments.noteId))
        .where(and(eq(noteAttachments.clientId, clientId), eq(notes.scope, "team")))
        .groupBy(notes.workspaceId),
    ]);

    const byWorkspace = new Map<string, Totals>();
    for (const row of [...cardsByWorkspace, ...notesByWorkspace]) {
      const current = byWorkspace.get(row.workspaceId) ?? { bytes: 0, count: 0 };
      const add = toTotals(row);
      byWorkspace.set(row.workspaceId, { bytes: current.bytes + add.bytes, count: current.count + add.count });
    }
    const workspaceIds = [...byWorkspace.keys()];
    const workspaceRows = workspaceIds.length === 0 ? [] : await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        kind: workspaces.kind,
        // A standalone board lives in a hidden workspace; the board's own name is the one people know.
        boardName: sql<string | null>`(select ${boards.name} from ${boards} where ${boards.workspaceId} = ${workspaces.id} order by ${boards.createdAt} limit 1)`,
      })
      .from(workspaces)
      .where(inArray(workspaces.id, workspaceIds));

    const { billingStatus: _billingStatus, currentPeriodEnd: _currentPeriodEnd, plan: _plan, ...usage } = entitlements;
    const personal = toTotals(personalNoteTotals);
    const scratchpad = toTotals(scratchpadTotals);
    return {
      usage,
      warningPercent: dto.STORAGE_WARNING_PERCENT,
      categories: [
        { key: "cards", ...toTotals(cardTotals) },
        { key: "notes", ...toTotals(teamNoteTotals) },
        { key: "personal", bytes: personal.bytes + scratchpad.bytes, count: personal.count + scratchpad.count },
      ],
      workspaces: workspaceRows
        .map((workspace) => ({
          workspaceId: workspace.id,
          name: workspace.kind === "board" ? (workspace.boardName ?? workspace.name) : workspace.name,
          kind: workspace.kind,
          ...byWorkspace.get(workspace.id)!,
        }))
        .sort((a, b) => b.bytes - a.bytes),
    };
  });

  app.get("/clients/me/storage/files", async (req) => {
    assertOrgRole(req.auth, "admin");
    const query = dto.storageFilesQuery.parse(req.query);

    const filters: SQL[] = [];
    if (query.kind !== "all") filters.push(sql`kind = ${query.kind}`);
    if (query.minBytes !== undefined) filters.push(sql`byte_size >= ${query.minBytes}`);
    if (query.olderThanDays !== undefined) filters.push(sql`created_at < now() - make_interval(days => ${query.olderThanDays})`);
    if (query.archivedOnly) filters.push(sql`archived`);
    if (query.workspaceId) filters.push(sql`workspace_id = ${query.workspaceId}`);
    const where = filters.length > 0 ? sql`where ${sql.join(filters, sql` and `)}` : sql``;
    const orderBy = query.sort === "oldest" ? sql`created_at asc, id asc` : sql`byte_size desc, created_at asc, id asc`;
    const source = storageFilesSource(req.auth.cid);

    const [page, totals] = await Promise.all([
      db.execute<StorageFileDbRow>(sql`
        select * from (${source}) files ${where}
        order by ${orderBy}
        limit ${query.limit} offset ${query.offset}
      `),
      db.execute<{ total: number; total_bytes: string | number }>(sql`
        select count(*)::int as total, coalesce(sum(byte_size), 0)::bigint as total_bytes from (${source}) files ${where}
      `),
    ]);

    const items: StorageFileRow[] = page.rows.map((row) => ({
      kind: row.kind,
      id: row.id,
      fileName: row.file_name,
      mimeType: row.mime_type,
      byteSize: Number(row.byte_size),
      createdAt: new Date(row.created_at).toISOString(),
      uploadedByName: row.uploaded_by_name,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      workspaceKind: row.workspace_kind,
      boardId: row.board_id,
      boardName: row.board_name,
      cardId: row.card_id,
      cardKey: row.card_key,
      organisationKey: row.organisation_key,
      cardTitle: row.card_title,
      noteId: row.note_id,
      noteTitle: row.note_title,
      archived: row.archived,
    }));
    return { items, total: totals.rows[0]?.total ?? 0, totalBytes: Number(totals.rows[0]?.total_bytes ?? 0) };
  });

  app.post("/clients/me/storage/files/delete", async (req) => {
    const body = dto.deleteStorageFilesBody.parse(req.body);
    assertOrgRole(req.auth, "admin");
    const clientId = req.auth.cid;

    const cardIds = body.files.filter((file) => file.kind === "card").map((file) => file.id);
    const noteIds = body.files.filter((file) => file.kind === "note").map((file) => file.id);
    // Scoping by client_id keeps the tool to files this organisation pays for; ids from elsewhere
    // are skipped silently rather than revealing whether they exist.
    const [cardRows, noteRows] = await Promise.all([
      cardIds.length === 0 ? [] : db.select().from(cardAttachments)
        .where(and(inArray(cardAttachments.id, cardIds), eq(cardAttachments.clientId, clientId))),
      noteIds.length === 0 ? [] : db.select().from(noteAttachments)
        .where(and(inArray(noteAttachments.id, noteIds), eq(noteAttachments.clientId, clientId))),
    ]);

    let deletedCount = 0;
    let freedBytes = 0;

    for (const attachment of cardRows) {
      const [card] = await db.select().from(cards).where(eq(cards.id, attachment.cardId)).limit(1);
      if (!card) continue;
      // Org admins manage every board their organisation owns. Unlike the card route this allows
      // archived cards on purpose: files parked on archived work are the main thing a cleanup frees.
      const ctx = await assertCardAccess(req.auth, card, "editor");
      await removeCardAttachment({
        card,
        attachment,
        workspaceId: ctx.workspaceId,
        actorId: req.auth.sub,
        mediaClientId: clientId,
        log: req.log,
      });
      deletedCount += 1;
      freedBytes += attachment.byteSize;
    }

    if (noteRows.length > 0) {
      const noteById = new Map(
        (await db.select().from(notes).where(inArray(notes.id, [...new Set(noteRows.map((row) => row.noteId))])))
          .map((note) => [note.id, note]),
      );
      for (const attachment of noteRows) {
        const note = noteById.get(attachment.noteId);
        // Personal notes are private to their owner even from organisation admins.
        if (!note || note.scope !== "team") continue;
        await removeNoteAttachment({ note, attachment, actorId: req.auth.sub, mediaClientId: clientId });
        deletedCount += 1;
        freedBytes += attachment.byteSize;
      }
    }

    // Sessions carry storage usage on /me; refresh them so upload gates and the plan page see the
    // freed space without a reload.
    if (deletedCount > 0) emitClientEntitlementsChanged(clientId);
    return { deletedCount, freedBytes };
  });
}
