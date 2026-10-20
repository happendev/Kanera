import "../../test/setup.integration.js";
import { insertTestUsers } from "../../test/user-fixtures.js";
import type { BoardTileSummary } from "@kanera/shared/dto";
import { boardMembers, boards, cardAssignees, cardChecklistItems, cardChecklists, cards, lists } from "@kanera/shared/schema";
import { asc, eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { db } from "../../db.js";
import { addDays, localDateInTimezone } from "../../lib/due-date.js";
import { signupOwner } from "../../test/api-fixtures.js";
import { buildIntegrationServer } from "../../test/integration.js";

let position = 0;
async function addCard(fields: { boardId: string; listId: string; title: string; createdById: string; dueDateLocalDate?: string; completedAt?: Date; archivedAt?: Date; assigneeId?: string }) {
  position += 1;
  const [card] = await db.insert(cards).values({
    boardId: fields.boardId,
    listId: fields.listId,
    title: fields.title,
    position: `${position * 1000}.0000000000`,
    createdById: fields.createdById,
    dueDateLocalDate: fields.dueDateLocalDate,
    dueDateSlot: fields.dueDateLocalDate ? "anyTime" : undefined,
    dueDateTimezone: fields.dueDateLocalDate ? "UTC" : undefined,
    completedAt: fields.completedAt,
    archivedAt: fields.archivedAt,
  }).returning();
  if (fields.assigneeId) await db.insert(cardAssignees).values({ cardId: card!.id, userId: fields.assigneeId });
  return card!;
}

async function addChecklist(cardId: string, items: Array<{ text: string; done?: boolean }>) {
  const [checklist] = await db.insert(cardChecklists).values({ cardId, title: "Steps", position: "1000.0000000000" }).returning();
  await db.insert(cardChecklistItems).values(items.map((item, index) => ({
    checklistId: checklist!.id,
    text: item.text,
    position: `${(index + 1) * 1000}.0000000000`,
    completedAt: item.done ? new Date() : undefined,
  })));
}

void test("tile summaries count the Portfolio's cards per board and honour the assigned-items restriction", async () => {
  const app = await buildIntegrationServer();
  const owner = await signupOwner(app, { seed: "tile-summaries" });
  const created = await app.inject({ method: "POST", url: "/workspaces", headers: owner.auth, payload: { name: "Tiles" } });
  assert.equal(created.statusCode, 201);
  const workspaceId = created.json<{ id: string }>().id;
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspaceId)).orderBy(asc(lists.position)).limit(1);
  assert.ok(list);
  const [mainBoard, emptyBoard] = await db.insert(boards).values([
    { workspaceId, name: "Main", position: "1000.0000000000" },
    { workspaceId, name: "Empty", position: "2000.0000000000" },
  ]).returning();
  const workspace = { boardId: mainBoard!.id, listId: list.id };
  const [teammate, restricted] = await insertTestUsers(db, [
    { clientId: owner.user.clientId, email: "teammate-tile-summaries@example.com", passwordHash: "x", displayName: "Teammate", clientRole: "member" },
    { clientId: owner.user.clientId, email: "restricted-tile-summaries@example.com", passwordHash: "x", displayName: "Restricted", clientRole: "member" },
  ]).returning();
  await db.insert(boardMembers).values([
    { boardId: workspace.boardId, userId: teammate!.id, role: "editor" },
    { boardId: workspace.boardId, userId: restricted!.id, role: "observer", assignedItemsOnly: true },
  ]);

  const today = localDateInTimezone(new Date(), "UTC");
  const base = { boardId: workspace.boardId, listId: workspace.listId, createdById: owner.user.id };
  await addCard({ ...base, title: "Late", dueDateLocalDate: addDays(today, -1), assigneeId: restricted!.id });
  await addCard({ ...base, title: "Soon", dueDateLocalDate: addDays(today, 3) });
  const later = await addCard({ ...base, title: "Later", dueDateLocalDate: addDays(today, 10) });
  await addChecklist(later.id, [{ text: "Draft", done: true }, { text: "Review" }]);
  await addCard({ ...base, title: "No due date" });
  const done = await addCard({ ...base, title: "Done", completedAt: new Date() });
  await addChecklist(done.id, [{ text: "Finished work stays out of the checklist count" }]);
  await addCard({ ...base, title: "Archived", archivedAt: new Date() });

  const query = async (auth: { authorization: string }, boardIds: string[]) => {
    const response = await app.inject({ method: "POST", url: "/boards/tile-summaries/query", headers: auth, payload: { boardIds } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<BoardTileSummary[]>();
  };

  // The owner sees every unarchived card; an unknown id is dropped rather than rejected, so a stale
  // recents entry on the client cannot break the whole strip.
  const ownerRows = await query(owner.auth, [workspace.boardId, emptyBoard!.id, randomUUID()]);
  assert.deepEqual(ownerRows.map((row) => row.boardId).sort(), [workspace.boardId, emptyBoard!.id].sort());
  const main = ownerRows.find((row) => row.boardId === workspace.boardId)!;
  assert.equal(main.open, 4);
  assert.equal(main.completed, 1);
  assert.equal(main.overdue, 1);
  assert.equal(main.checklistDone, 1);
  assert.equal(main.checklistTotal, 2);
  assert.equal(main.nextDueDate, addDays(today, 3));
  assert.ok(main.lastActivityAt && !Number.isNaN(Date.parse(main.lastActivityAt)));
  assert.equal(main.memberCount, main.members.length);
  assert.ok(main.members.length <= 4);
  assert.deepEqual(
    main.members.filter((member) => member.userId !== owner.user.id).map((member) => member.displayName),
    ["Teammate", "Restricted"],
  );

  const empty = ownerRows.find((row) => row.boardId === emptyBoard!.id)!;
  assert.deepEqual(
    { open: empty.open, completed: empty.completed, overdue: empty.overdue, checklistTotal: empty.checklistTotal, nextDueDate: empty.nextDueDate, lastActivityAt: empty.lastActivityAt },
    { open: 0, completed: 0, overdue: 0, checklistTotal: 0, nextDueDate: null, lastActivityAt: null },
  );

  // A restricted member counts only the cards they are assigned to, exactly as the Portfolio does.
  const restrictedAuth = { authorization: `Bearer ${app.jwt.sign({ sub: restricted!.id, cid: owner.user.clientId, role: "member" })}` };
  const restrictedRows = await query(restrictedAuth, [workspace.boardId, emptyBoard!.id]);
  assert.deepEqual(restrictedRows.map((row) => row.boardId), [workspace.boardId]);
  const restrictedMain = restrictedRows[0]!;
  assert.equal(restrictedMain.open, 1);
  assert.equal(restrictedMain.overdue, 1);
  assert.equal(restrictedMain.completed, 0);
  assert.equal(restrictedMain.checklistTotal, 0);
  assert.equal(restrictedMain.nextDueDate, null);
  assert.equal(restrictedMain.memberCount, main.memberCount);

  // Another organisation's owner gets nothing back for a board they cannot open.
  const outsider = await signupOwner(app, { seed: "tile-summaries-outsider" });
  assert.deepEqual(await query(outsider.auth, [workspace.boardId]), []);

  const invalid = await app.inject({ method: "POST", url: "/boards/tile-summaries/query", headers: owner.auth, payload: { boardIds: [] } });
  assert.equal(invalid.statusCode, 400);
});
