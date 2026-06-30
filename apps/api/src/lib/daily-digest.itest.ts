import "../test/setup.integration.js";
import {
  boards,
  cardAssignees,
  cards,
  clients,
  emailQueue,
  lists,
  users,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../db.js";
import "../test/integration.js";
import { runDailyDigestSweep } from "./daily-digest.js";

const log = {
  info() { },
  error() { },
  warn() { },
} as never;

void test("daily digest queues due items at the user's local 8am and skips observers", async () => {
  const f = await seed();

  assert.equal(await runDailyDigestSweep(deps(), new Date("2026-05-26T06:59:00Z")), 0);
  assert.equal(await runDailyDigestSweep(deps(), new Date("2026-05-26T07:15:00Z")), 1);
  assert.equal(await runDailyDigestSweep(deps(), new Date("2026-05-26T07:30:00Z")), 0);

  const rows = await db.select().from(emailQueue).where(eq(emailQueue.type, "daily_digest"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.toEmail, "member@example.com");

  const data = rows[0]!.data as {
    localDate: string;
    dueToday: Array<{ title: string; boardName: string; cardUrl: string }>;
    overdue: Array<{ title: string; boardName: string; cardUrl: string }>;
  };
  assert.equal(data.localDate, "2026-05-26");
  assert.deepEqual(data.dueToday.map((item) => item.title), ["Due today"]);
  assert.deepEqual(data.overdue.map((item) => item.title), ["Overdue"]);
  assert.equal(data.dueToday[0]!.boardName, "Launch");
  assert.equal(data.dueToday[0]!.cardUrl, `http://web.test/b/${f.board.id}?cardId=${f.dueToday.id}`);
});

function deps() {
  return {
    db,
    webOrigin: "http://web.test",
    resolveSmtpConfig: async () => null,
    log,
  };
}

async function seed() {
  const [client] = await db.insert(clients).values({ name: "Acme" }).returning();
  const [workspace] = await db.insert(workspaces).values({ clientId: client!.id, name: "Delivery" }).returning();
  const [list] = await db
    .insert(lists)
    .values({ workspaceId: workspace!.id, name: "Doing", position: "1000.0000000000" })
    .returning();
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace!.id, name: "Launch", position: "1000.0000000000", visibility: "workspace" })
    .returning();
  const [member] = await db
    .insert(users)
    .values({
      clientId: client!.id,
      email: "member@example.com",
      passwordHash: "x",
      displayName: "Member User",
      timezone: "Europe/Dublin",
    })
    .returning();
  const [observer] = await db
    .insert(users)
    .values({
      clientId: client!.id,
      email: "observer@example.com",
      passwordHash: "x",
      displayName: "Observer User",
      timezone: "Europe/Dublin",
    })
    .returning();
  const [laterUser] = await db
    .insert(users)
    .values({
      clientId: client!.id,
      email: "later@example.com",
      passwordHash: "x",
      displayName: "Later User",
      timezone: "America/New_York",
    })
    .returning();
  await db.insert(workspaceMembers).values([
    { workspaceId: workspace!.id, userId: member!.id, role: "editor" },
    { workspaceId: workspace!.id, userId: observer!.id, role: "observer" },
    { workspaceId: workspace!.id, userId: laterUser!.id, role: "editor" },
  ]);

  const dueToday = await insertCard(list!.id, board!.id, member!.id, "Due today", "2026-05-26");
  const overdue = await insertCard(list!.id, board!.id, member!.id, "Overdue", "2026-05-25");
  await insertCard(list!.id, board!.id, member!.id, "Future", "2026-05-27");
  await insertCard(list!.id, board!.id, observer!.id, "Observer due today", "2026-05-26");
  await insertCard(list!.id, board!.id, laterUser!.id, "New York due today", "2026-05-26");

  return { board: board!, dueToday, overdue };
}

async function insertCard(listId: string, boardId: string, userId: string, title: string, dueDateLocalDate: string) {
  const [card] = await db
    .insert(cards)
    .values({
      listId,
      boardId,
      title,
      dueDateLocalDate,
      position: "1000.0000000000",
      createdById: userId,
    })
    .returning();
  await db.insert(cardAssignees).values({ cardId: card!.id, userId });
  return card!;
}
