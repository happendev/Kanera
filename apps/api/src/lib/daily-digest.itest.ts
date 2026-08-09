import "../test/setup.integration.js";
import { insertTestUsers } from "../test/user-fixtures.js";
import {
  boards,
  cardAssignees,
  cardPriorities,
  cards,
  clients,
  emailQueue,
  lists,
  boardMembers,
  workspaceMembers,
  workspaces,
  userNotificationWorkspaceRules,
  type DailyDigestEmailQueueData,
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
  assert.equal(data.dueToday[0]!.cardUrl, `http://web.test/o/${f.dueToday.organisationKey}/c/${f.dueToday.key}`);
});

void test("daily digest excludes every item covered by a paused workspace rule", async () => {
  const f = await seed();
  await db.insert(userNotificationWorkspaceRules).values({
    userId: f.member.id,
    workspaceId: f.workspace.id,
    paused: true,
  });

  assert.equal(await runDailyDigestSweep(deps(), new Date("2026-05-26T07:15:00Z")), 0);
  const rows = await db.select().from(emailQueue).where(eq(emailQueue.type, "daily_digest"));
  assert.equal(rows.length, 0);
});

void test("daily digest excludes items when the workspace overdue type is disabled", async () => {
  const f = await seed();
  await db.insert(userNotificationWorkspaceRules).values({
    userId: f.member.id,
    workspaceId: f.workspace.id,
    cardOverdueEmail: false,
  });

  assert.equal(await runDailyDigestSweep(deps(), new Date("2026-05-26T07:15:00Z")), 0);
  const rows = await db.select().from(emailQueue).where(eq(emailQueue.type, "daily_digest"));
  assert.equal(rows.length, 0);
});

void test("the digest reprints the head of the recipient's own Up next, in queue order", async () => {
  const f = await seed();
  // Ranks 1..3 come from the queue's positions, and #2 is the card that is *not* due — the section
  // reprints the queue, not a re-sort of the due items above it.
  await db.insert(cardPriorities).values([
    { targetUserId: f.member.id, cardId: f.overdue.id, position: "1000.0000000000", createdById: f.member.id },
    { targetUserId: f.member.id, cardId: f.future.id, position: "2000.0000000000", createdById: f.member.id },
    { targetUserId: f.member.id, cardId: f.dueToday.id, position: "3000.0000000000", createdById: f.member.id },
  ]);

  assert.equal(await runDailyDigestSweep(deps(), new Date("2026-05-26T07:15:00Z")), 1);
  const [row] = await db.select().from(emailQueue).where(eq(emailQueue.type, "daily_digest"));
  const data = row!.data as DailyDigestEmailQueueData;
  assert.ok(data.priorities);

  assert.deepEqual(data.priorities!.map((item) => [item.rank, item.title]), [
    [1, "Overdue"],
    [2, "Future"],
    [3, "Due today"],
  ]);
  assert.equal(data.priorities![0]!.boardName, "Launch");
  assert.equal(data.priorities![0]!.cardUrl, `http://web.test/o/${f.overdue.organisationKey}/c/${f.overdue.key}`);
  assert.equal(data.priorities![2]!.dueLabel, "Today");
});

void test("the digest's queue section excludes completed, archived and unassigned entries", async () => {
  const f = await seed();
  await db.insert(cardPriorities).values([
    { targetUserId: f.member.id, cardId: f.overdue.id, position: "1000.0000000000", createdById: f.member.id },
    { targetUserId: f.member.id, cardId: f.future.id, position: "2000.0000000000", createdById: f.member.id },
    { targetUserId: f.member.id, cardId: f.dueToday.id, position: "3000.0000000000", createdById: f.member.id },
  ]);
  // Exactly the queue endpoint's live set, so an email rank can never disagree with the app's.
  await db.update(cards).set({ completedAt: new Date() }).where(eq(cards.id, f.overdue.id));
  await db.delete(cardAssignees).where(eq(cardAssignees.cardId, f.future.id));

  assert.equal(await runDailyDigestSweep(deps(), new Date("2026-05-26T07:15:00Z")), 1);
  const [row] = await db.select().from(emailQueue).where(eq(emailQueue.type, "daily_digest"));
  const data = row!.data as DailyDigestEmailQueueData;
  assert.ok(data.priorities);
  assert.deepEqual(data.priorities!.map((item) => [item.rank, item.title]), [[1, "Due today"]]);
});

void test("a queue alone never triggers a digest, and a due recipient with none gets an empty section", async () => {
  const f = await seed();
  // `laterUser` has a queue but nothing due at 07:15 UTC (their 8am is hours away). A durable queue
  // would otherwise email them the identical list every morning forever.
  await db.insert(cardPriorities).values({
    targetUserId: f.laterUser.id,
    cardId: f.newYorkDueToday.id,
    position: "1000.0000000000",
    createdById: f.laterUser.id,
  });

  assert.equal(await runDailyDigestSweep(deps(), new Date("2026-05-26T07:15:00Z")), 1);
  const rows = await db.select().from(emailQueue).where(eq(emailQueue.type, "daily_digest"));
  assert.deepEqual(rows.map((row) => row.toEmail), ["member@example.com"]);
  // The one recipient who did qualify has no queue at all: the section is skipped, not omitted.
  assert.deepEqual((rows[0]!.data as DailyDigestEmailQueueData).priorities, []);
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
    .values({ workspaceId: workspace!.id, name: "Launch", position: "1000.0000000000" })
    .returning();
  const [member] = await insertTestUsers(db, {
      clientId: client!.id,
      email: "member@example.com",
      passwordHash: "x",
      displayName: "Member User",
      timezone: "Europe/Dublin",
    })
    .returning();
  const [observer] = await insertTestUsers(db, {
      clientId: client!.id,
      email: "observer@example.com",
      passwordHash: "x",
      displayName: "Observer User",
      timezone: "Europe/Dublin",
    })
    .returning();
  const [laterUser] = await insertTestUsers(db, {
      clientId: client!.id,
      email: "later@example.com",
      passwordHash: "x",
      displayName: "Later User",
      timezone: "America/New_York",
    })
    .returning();
  // Workspace role no longer gates digest eligibility; the editor/observer distinction is a board
  // role. All three are plain workspace members.
  await db.insert(workspaceMembers).values([
    { workspaceId: workspace!.id, userId: member!.id, role: "member" },
    { workspaceId: workspace!.id, userId: observer!.id, role: "member" },
    { workspaceId: workspace!.id, userId: laterUser!.id, role: "member" },
  ]);
  // Digest recipients are non-observer board members: board membership is the access model.
  await db.insert(boardMembers).values([
    { boardId: board!.id, userId: member!.id, role: "editor" },
    { boardId: board!.id, userId: observer!.id, role: "observer" },
    { boardId: board!.id, userId: laterUser!.id, role: "editor" },
  ]);

  const dueToday = await insertCard(list!.id, board!.id, member!.id, "Due today", "2026-05-26");
  const overdue = await insertCard(list!.id, board!.id, member!.id, "Overdue", "2026-05-25");
  const future = await insertCard(list!.id, board!.id, member!.id, "Future", "2026-05-27");
  await insertCard(list!.id, board!.id, observer!.id, "Observer due today", "2026-05-26");
  const newYorkDueToday = await insertCard(list!.id, board!.id, laterUser!.id, "New York due today", "2026-05-26");

  return {
    workspace: workspace!,
    board: board!,
    member: member!,
    laterUser: laterUser!,
    dueToday,
    overdue,
    future,
    newYorkDueToday,
  };
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
