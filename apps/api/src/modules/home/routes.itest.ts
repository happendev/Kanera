import "../../test/setup.integration.js";
import { insertTestUsers } from "../../test/user-fixtures.js";
import type { HomeItem, HomeTodayResponse } from "@kanera/shared/dto";
import {
  ACTIVITY_ACTION,
  activityEvents,
  boardGroups,
  boardMembers,
  boards,
  cardAssignees,
  cardChecklistItems,
  cardChecklists,
  cardLabelAssignments,
  cardLabels,
  cards,
  clientMembers,
  clients,
  lists,
  planActions,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { addDays, localDateInTimezone } from "../../lib/due-date.js";
import { buildIntegrationServer, testUploadsDir } from "../../test/integration.js";

/**
 * Cloned from work/routes.itest.ts: two organisations, a viewer plus a teammate and a partner, a
 * standard workspace, a `kind: "board"` standalone workspace, a partner workspace, and boards
 * shared / restricted (viewer is assignedItemsOnly) / standalone / guest / archived. That fixture
 * already exercises every access branch home has to respect.
 */
async function seed() {
  const app = await buildIntegrationServer();
  const [homeClient, externalClient] = await db.insert(clients).values([
    { name: "Home org" },
    { name: "Partner org" },
  ]).returning();
  const [viewer, teammate, partner] = await insertTestUsers(db, [
    { clientId: homeClient!.id, email: "viewer@home.test", passwordHash: "x", displayName: "Viewer", clientRole: "member", timezone: "UTC" },
    { clientId: homeClient!.id, email: "teammate@home.test", passwordHash: "x", displayName: "Teammate", clientRole: "member" },
    { clientId: externalClient!.id, email: "partner@home.test", passwordHash: "x", displayName: "Partner", clientRole: "owner" },
  ]).returning();
  const [homeWorkspace, secondWorkspace, partnerWorkspace] = await db.insert(workspaces).values([
    { clientId: homeClient!.id, name: "Delivery" },
    { clientId: homeClient!.id, name: "Product", kind: "board" },
    { clientId: externalClient!.id, name: "Partner space" },
  ]).returning();
  await db.insert(workspaceMembers).values([
    { workspaceId: homeWorkspace!.id, userId: viewer!.id, role: "member" },
    { workspaceId: homeWorkspace!.id, userId: teammate!.id, role: "member" },
    { workspaceId: secondWorkspace!.id, userId: viewer!.id, role: "member" },
    { workspaceId: partnerWorkspace!.id, userId: partner!.id, role: "admin" },
  ]);
  const [homeList, secondList, partnerList, archivedList] = await db.insert(lists).values([
    { workspaceId: homeWorkspace!.id, name: "Doing", position: "1000.0000000000" },
    { workspaceId: secondWorkspace!.id, name: "Building", position: "1000.0000000000" },
    { workspaceId: partnerWorkspace!.id, name: "Launching", position: "1000.0000000000" },
    { workspaceId: homeWorkspace!.id, name: "Retired", position: "2000.0000000000", archivedAt: new Date() },
  ]).returning();
  const [priorityBoardGroup] = await db.insert(boardGroups).values({
    workspaceId: homeWorkspace!.id,
    title: "Priority boards",
    position: "1000.0000000000",
  }).returning();
  const [sharedBoard, restrictedBoard, secondBoard, guestBoard, archivedBoard] = await db.insert(boards).values([
    { workspaceId: homeWorkspace!.id, name: "Shared", position: "1000.0000000000" },
    { workspaceId: homeWorkspace!.id, groupId: priorityBoardGroup!.id, name: "Restricted", position: "2000.0000000000" },
    { workspaceId: secondWorkspace!.id, name: "Standalone-like", position: "1000.0000000000" },
    { workspaceId: partnerWorkspace!.id, name: "Guest launch", position: "1000.0000000000" },
    { workspaceId: homeWorkspace!.id, name: "Archived secret", position: "3000.0000000000", archivedAt: new Date() },
  ]).returning();
  await db.insert(boardMembers).values([
    { boardId: sharedBoard!.id, userId: viewer!.id, role: "editor" },
    { boardId: sharedBoard!.id, userId: teammate!.id, role: "editor" },
    { boardId: restrictedBoard!.id, userId: viewer!.id, role: "observer", assignedItemsOnly: true },
    { boardId: restrictedBoard!.id, userId: teammate!.id, role: "editor" },
    { boardId: secondBoard!.id, userId: viewer!.id, role: "editor" },
    { boardId: guestBoard!.id, userId: viewer!.id, role: "observer" },
    { boardId: guestBoard!.id, userId: partner!.id, role: "editor" },
    { boardId: archivedBoard!.id, userId: viewer!.id, role: "editor" },
  ]);

  const viewerToken = app.jwt.sign({ sub: viewer!.id, cid: homeClient!.id, role: "member" });
  const teammateToken = app.jwt.sign({ sub: teammate!.id, cid: homeClient!.id, role: "member" });
  return {
    app,
    viewer: viewer!,
    teammate: teammate!,
    partner: partner!,
    viewerToken,
    teammateToken,
    homeClient: homeClient!,
    externalClient: externalClient!,
    homeWorkspace: homeWorkspace!,
    sharedBoard: sharedBoard!,
    restrictedBoard: restrictedBoard!,
    secondBoard: secondBoard!,
    guestBoard: guestBoard!,
    archivedBoard: archivedBoard!,
    homeList: homeList!,
    secondList: secondList!,
    partnerList: partnerList!,
    archivedList: archivedList!,
  };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

let cardPosition = 0;
async function addCard(fields: {
  boardId: string;
  listId: string;
  title: string;
  createdById: string;
  assigneeId?: string;
  dueDateLocalDate?: string;
  dueDateSlot?: "anyTime" | "morning" | "afternoon" | "endOfWorkDay";
  dueDateTimezone?: string;
  completedAt?: Date;
  archivedAt?: Date;
}) {
  cardPosition += 1;
  const [card] = await db.insert(cards).values({
    boardId: fields.boardId,
    listId: fields.listId,
    title: fields.title,
    position: `${cardPosition * 1000}.0000000000`,
    createdById: fields.createdById,
    dueDateLocalDate: fields.dueDateLocalDate,
    dueDateSlot: fields.dueDateSlot,
    dueDateTimezone: fields.dueDateTimezone,
    completedAt: fields.completedAt,
    archivedAt: fields.archivedAt,
  }).returning();
  if (fields.assigneeId) await db.insert(cardAssignees).values({ cardId: card!.id, userId: fields.assigneeId });
  return card!;
}

let itemPosition = 0;
async function addChecklistItem(cardId: string, fields: {
  text: string;
  assigneeId?: string;
  dueDateLocalDate?: string;
  dueDateSlot?: "anyTime" | "morning" | "afternoon" | "endOfWorkDay";
  dueDateTimezone?: string;
  completedAt?: Date;
  completedById?: string;
}) {
  itemPosition += 1;
  const [checklist] = await db.insert(cardChecklists).values({
    cardId,
    title: "Steps",
    position: `${itemPosition * 1000}.0000000000`,
  }).returning();
  const [item] = await db.insert(cardChecklistItems).values({
    checklistId: checklist!.id,
    text: fields.text,
    position: "1000.0000000000",
    assigneeId: fields.assigneeId,
    dueDateLocalDate: fields.dueDateLocalDate,
    dueDateSlot: fields.dueDateSlot,
    dueDateTimezone: fields.dueDateTimezone,
    completedAt: fields.completedAt,
    completedById: fields.completedById,
  }).returning();
  return item!;
}

async function addCompletionActivity(fields: {
  boardId: string;
  cardId: string;
  actorId: string;
  clientId: string;
  createdAt: Date;
  action?: string;
  payload?: Record<string, unknown>;
  feedVisible?: boolean;
  coalescedCount?: number;
}) {
  await db.insert(activityEvents).values({
    clientId: fields.clientId,
    boardId: fields.boardId,
    entityType: "card",
    entityId: fields.cardId,
    action: fields.action ?? ACTIVITY_ACTION.COMPLETED,
    actorId: fields.actorId,
    actorKind: "user",
    payload: fields.payload ?? {},
    feedVisible: fields.feedVisible ?? true,
    coalescedCount: fields.coalescedCount ?? 1,
    createdAt: fields.createdAt,
  });
}

async function today(f: Awaited<ReturnType<typeof seed>>, timeZone = "UTC"): Promise<HomeTodayResponse> {
  const url = timeZone === "UTC" ? "/home/today" : `/home/today?timeZone=${encodeURIComponent(timeZone)}`;
  const response = await f.app.inject({ method: "GET", url, headers: auth(f.viewerToken) });
  assert.equal(response.statusCode, 200);
  return response.json<HomeTodayResponse>();
}

function ids(items: HomeItem[]): string[] {
  return items.map((item) => item.id);
}

void test("other organisation memberships stay behind the switcher instead of appearing as guest boards", async () => {
  const f = await seed();
  const before = await f.app.inject({ method: "GET", url: "/home/boards", headers: auth(f.viewerToken) });
  assert.equal(before.statusCode, 200, before.body);
  const beforeGuestBoardIds = before.json<{ guestGroups: { boards: { id: string }[] }[] }>()
    .guestGroups.flatMap((group) => group.boards.map((board) => board.id));
  assert.ok(beforeGuestBoardIds.includes(f.guestBoard.id), "a genuine board guest remains visible");

  await db.insert(clientMembers).values({
    clientId: f.externalClient.id,
    userId: f.viewer.id,
    clientRole: "member",
  });

  const after = await f.app.inject({ method: "GET", url: "/home/boards", headers: auth(f.viewerToken) });
  assert.equal(after.statusCode, 200, after.body);
  const afterBody = after.json<{ guestGroups: { workspace: { clientId: string }; boards: { id: string }[] }[] }>();
  assert.ok(!afterBody.guestGroups.some((group) => group.workspace.clientId === f.externalClient.id));
  assert.ok(!afterBody.guestGroups.flatMap((group) => group.boards).some((board) => board.id === f.guestBoard.id));
});

void test("the board directory shows downgrade-disabled boards but keeps ordinary archives hidden", async () => {
  const f = await seed();
  const before = await f.app.inject({ method: "GET", url: "/home/boards", headers: auth(f.viewerToken) });
  assert.equal(before.statusCode, 200, before.body);
  assert.ok(!before.body.includes("Archived secret"));

  await db.insert(planActions).values({
    clientId: f.homeClient.id,
    kind: "board_archived",
    payload: { boardId: f.archivedBoard.id },
  });
  const after = await f.app.inject({ method: "GET", url: "/home/boards", headers: auth(f.viewerToken) });
  assert.equal(after.statusCode, 200, after.body);
  const body = after.json<{
    groups: { boards: { id: string; disabledByPlan: boolean }[] }[];
  }>();
  const disabled = body.groups.flatMap((group) => group.boards).find((board) => board.id === f.archivedBoard.id);
  assert.deepEqual(disabled, {
    id: f.archivedBoard.id,
    workspaceId: f.archivedBoard.workspaceId,
    name: f.archivedBoard.name,
    icon: f.archivedBoard.icon,
    iconColor: f.archivedBoard.iconColor,
    backgroundGradient: f.archivedBoard.backgroundGradient,
    groupId: f.archivedBoard.groupId,
    standaloneGroupId: f.archivedBoard.standaloneGroupId,
    position: f.archivedBoard.position,
    viewerRole: "editor",
    disabledByPlan: true,
    myCards: 0,
    myOverdue: 0,
  });
});

/** Regression guard for the core complaint: overdue work must be a list, not just a chip count. */
void test("overdue work appears as agenda rows, not only as a count", async () => {
  const f = await seed();
  const now = new Date();
  const day = localDateInTimezone(now, "UTC");
  const overdueCard = await addCard({
    boardId: f.sharedBoard.id,
    listId: f.homeList.id,
    title: "Long overdue card",
    createdById: f.viewer.id,
    assigneeId: f.viewer.id,
    dueDateLocalDate: addDays(day, -5),
    dueDateSlot: "anyTime",
    dueDateTimezone: "UTC",
  });
  const carrier = await addCard({
    boardId: f.sharedBoard.id,
    listId: f.homeList.id,
    title: "Carrier",
    createdById: f.viewer.id,
    assigneeId: f.viewer.id,
  });
  const overdueItem = await addChecklistItem(carrier.id, {
    text: "Long overdue step",
    assigneeId: f.viewer.id,
    dueDateLocalDate: addDays(day, -3),
    dueDateSlot: "anyTime",
    dueDateTimezone: "UTC",
  });

  const body = await today(f);
  assert.equal(body.counts.overdueCards, 1);
  assert.equal(body.counts.overdueChecklistItems, 1);
  const overdueRows = body.items.filter((item) => item.bucket === "overdue");
  assert.deepEqual(ids(overdueRows).sort(), [overdueCard.id, overdueItem.id].sort());
  // Checklist rows deep-link to the parent card, and carry the parent title for the sub-line.
  const row = overdueRows.find((item) => item.kind === "checklistItem")!;
  assert.equal(row.cardId, carrier.id);
  assert.equal(row.cardKey, carrier.key);
  assert.equal(row.cardTitle, "Carrier");
  assert.equal(row.listName, "Doing");
});

void test("rows carry board display fields and the card's labels", async () => {
  const f = await seed();
  const day = localDateInTimezone(new Date(), "UTC");
  await db.update(boards)
    .set({ icon: "rocket", iconColor: "violet" })
    .where(eq(boards.id, f.sharedBoard.id));
  const [bug, chore] = await db.insert(cardLabels).values([
    { workspaceId: f.homeWorkspace.id, name: "Bug", color: "rose", position: "1000.0000000000" },
    { workspaceId: f.homeWorkspace.id, name: "Chore", color: null, position: "2000.0000000000" },
    { workspaceId: f.homeWorkspace.id, name: "Unused", color: "teal", position: "3000.0000000000" },
  ]).returning();
  const card = await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "Labelled", createdById: f.viewer.id, assigneeId: f.viewer.id, dueDateLocalDate: day, dueDateSlot: "anyTime", dueDateTimezone: "UTC" });
  await db.insert(cardLabelAssignments).values([
    { cardId: card.id, labelId: bug!.id },
    { cardId: card.id, labelId: chore!.id },
  ]);
  // A checklist row shows its *parent card's* labels.
  const step = await addChecklistItem(card.id, { text: "A step", assigneeId: f.viewer.id, dueDateLocalDate: day, dueDateSlot: "anyTime", dueDateTimezone: "UTC" });

  const body = await today(f);
  const row = body.items.find((entry) => entry.id === card.id)!;
  assert.equal(row.boardIcon, "rocket");
  assert.equal(row.boardIconColor, "violet");
  assert.equal(row.listName, "Doing");
  assert.deepEqual(row.labels.map((label) => label.name), ["Bug", "Chore"]);
  assert.equal(row.labels[0]!.color, "rose");
  assert.equal(row.labels[1]!.color, null);
  assert.deepEqual(body.items.find((entry) => entry.id === step.id)!.labels.map((label) => label.name), ["Bug", "Chore"]);
  // Workspace labels the card does not carry must not leak onto the row.
  assert.ok(!JSON.stringify(body).includes("Unused"));
});

void test("horizon spans four buckets and undated work only reaches the assigned count", async () => {
  const f = await seed();
  const day = localDateInTimezone(new Date(), "UTC");
  // "morning" on today would already be overdue after 09:00 UTC, so today's row uses anyTime
  // (21:00 cut-off) to keep the bucket stable whenever the suite runs.
  const dueToday = await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "Due today", createdById: f.viewer.id, assigneeId: f.viewer.id, dueDateLocalDate: day, dueDateSlot: "anyTime", dueDateTimezone: "UTC" });
  const dueTomorrow = await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "Due tomorrow", createdById: f.viewer.id, assigneeId: f.viewer.id, dueDateLocalDate: addDays(day, 1), dueDateTimezone: "UTC" });
  const dueLater = await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "Due in three", createdById: f.viewer.id, assigneeId: f.viewer.id, dueDateLocalDate: addDays(day, 3), dueDateTimezone: "UTC" });
  await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "Beyond the horizon", createdById: f.viewer.id, assigneeId: f.viewer.id, dueDateLocalDate: addDays(day, 9), dueDateTimezone: "UTC" });
  await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "No due date", createdById: f.viewer.id, assigneeId: f.viewer.id });

  const body = await today(f);
  assert.equal(body.today, day);
  assert.equal(body.horizonEnd, addDays(day, 7));
  assert.deepEqual(ids(body.items), [dueToday.id, dueTomorrow.id, dueLater.id]);
  assert.deepEqual(body.items.map((item) => item.bucket), ["today", "tomorrow", "laterThisWeek"]);
  assert.equal(body.counts.dueTodayCards, 1);
  assert.equal(body.counts.dueTomorrowCards, 1);
  assert.equal(body.counts.dueLaterThisWeekCards, 1);
  assert.equal(body.counts.dueWithin7DaysCards, 3);
  // Undated and out-of-horizon work still counts as assigned; only the agenda is bounded.
  assert.equal(body.counts.assignedCards, 5);
  assert.equal(body.itemsTruncated, false);
});

void test("overdue precedence beats the today bucket", async () => {
  const f = await seed();
  const day = localDateInTimezone(new Date(), "UTC");
  // Due today at 09:00 UTC. Past that instant the card is overdue even though its wall-clock
  // date is still the viewer's today — overdue must win.
  const card = await addCard({
    boardId: f.sharedBoard.id,
    listId: f.homeList.id,
    title: "Due this morning",
    createdById: f.viewer.id,
    assigneeId: f.viewer.id,
    dueDateLocalDate: addDays(day, -1),
    dueDateSlot: "morning",
    dueDateTimezone: "UTC",
  });
  await db.update(cards).set({ dueDateLocalDate: day, dueDateSlot: "morning" }).where(eq(cards.id, card.id));

  const body = await today(f);
  const row = body.items.find((item) => item.id === card.id)!;
  const hasPassedMorning = new Date().getUTCHours() >= 9;
  assert.equal(row.bucket, hasPassedMorning ? "overdue" : "today");
  assert.equal(row.dueDateLocalDate, day);
  assert.equal(body.counts.overdueCards, hasPassedMorning ? 1 : 0);
  assert.equal(body.counts.dueTodayCards, hasPassedMorning ? 0 : 1);
});

void test("viewer zone drives bucketing and the query parameter overrides the profile zone", async () => {
  const f = await seed();
  // Kiritimati is UTC+14 and Niue UTC-11: a 25-hour spread, so the same instant is a different
  // calendar day in each. Around Kiritimati midnight their date keys are two days apart; otherwise
  // they are one day apart, and both cases must still bucket against the requested viewer zone.
  const kiritimatiToday = localDateInTimezone(new Date(), "Pacific/Kiritimati");
  const card = await addCard({
    boardId: f.sharedBoard.id,
    listId: f.homeList.id,
    title: "Zone sensitive",
    createdById: f.viewer.id,
    assigneeId: f.viewer.id,
    dueDateLocalDate: kiritimatiToday,
    dueDateSlot: "anyTime",
    // Far-future stored zone keeps the row out of "overdue" so the calendar bucket is observable.
    dueDateTimezone: "Pacific/Niue",
  });

  const kiritimati = await today(f, "Pacific/Kiritimati");
  const niue = await today(f, "Pacific/Niue");
  assert.equal(kiritimati.timeZone, "Pacific/Kiritimati");
  assert.equal(kiritimati.today, kiritimatiToday);
  assert.notEqual(niue.today, kiritimati.today);
  assert.equal(kiritimati.items.find((item) => item.id === card.id)?.bucket, "today");
  const niueBucket = kiritimatiToday === addDays(niue.today, 1) ? "tomorrow" : "laterThisWeek";
  assert.equal(niue.items.find((item) => item.id === card.id)?.bucket, niueBucket);

  // Profile zone is UTC, so omitting the parameter must not reuse the previous request's zone.
  const profile = await today(f);
  assert.equal(profile.timeZone, "UTC");
  assert.equal(profile.today, localDateInTimezone(new Date(), "UTC"));
});

void test("the card's own stored zone drives overdue-ness, not the viewer's", async () => {
  const f = await seed();
  const day = localDateInTimezone(new Date(), "UTC");
  const yesterday = addDays(day, -1);
  // Same wall-clock date and slot on both cards; only the stored zone differs. Kiritimati (+14) is
  // already well past yesterday, while Niue (-11) may still be on it.
  const aheadCard = await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "Set in Kiritimati", createdById: f.viewer.id, assigneeId: f.viewer.id, dueDateLocalDate: yesterday, dueDateSlot: "anyTime", dueDateTimezone: "Pacific/Kiritimati" });
  const behindCard = await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "Set in Niue", createdById: f.viewer.id, assigneeId: f.viewer.id, dueDateLocalDate: addDays(day, 1), dueDateSlot: "anyTime", dueDateTimezone: "Pacific/Niue" });

  const body = await today(f);
  const ahead = body.items.find((item) => item.id === aheadCard.id)!;
  const behind = body.items.find((item) => item.id === behindCard.id)!;
  assert.equal(ahead.bucket, "overdue");
  assert.notEqual(behind.bucket, "overdue");
  assert.equal(body.counts.overdueCards, 1);
  assert.equal(ahead.dueDateTimezone, "Pacific/Kiritimati");
});

void test("an invalid IANA zone is rejected with 400", async () => {
  const f = await seed();
  const response = await f.app.inject({
    method: "GET",
    url: "/home/today?timeZone=Mars%2FOlympus_Mons",
    headers: auth(f.viewerToken),
  });
  assert.equal(response.statusCode, 400);
});

void test("guest board items are included and labelled with the owning organisation", async () => {
  const f = await seed();
  const day = localDateInTimezone(new Date(), "UTC");
  const guestCard = await addCard({ boardId: f.guestBoard.id, listId: f.partnerList.id, title: "Guest work", createdById: f.partner.id, assigneeId: f.viewer.id, dueDateLocalDate: day, dueDateSlot: "anyTime", dueDateTimezone: "UTC" });
  const ownCard = await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "Own work", createdById: f.viewer.id, assigneeId: f.viewer.id, dueDateLocalDate: day, dueDateSlot: "anyTime", dueDateTimezone: "UTC" });

  const body = await today(f);
  assert.equal(body.items.find((item) => item.id === guestCard.id)?.guestOrganisationName, "Partner org");
  // Own-organisation rows must not repeat the viewer's own org name on every line.
  assert.equal(body.items.find((item) => item.id === ownCard.id)?.guestOrganisationName, null);
  assert.equal(body.items.find((item) => item.id === guestCard.id)?.workspaceName, "Partner space");
});

void test("assigned-items-only hides a teammate's card on a restricted board", async () => {
  const f = await seed();
  const day = localDateInTimezone(new Date(), "UTC");
  await addCard({ boardId: f.restrictedBoard.id, listId: f.homeList.id, title: "Hidden restricted team card", createdById: f.teammate.id, assigneeId: f.teammate.id, dueDateLocalDate: day, dueDateSlot: "anyTime", dueDateTimezone: "UTC" });
  const mine = await addCard({ boardId: f.restrictedBoard.id, listId: f.homeList.id, title: "My restricted card", createdById: f.teammate.id, assigneeId: f.viewer.id, dueDateLocalDate: day, dueDateSlot: "anyTime", dueDateTimezone: "UTC" });

  const body = await today(f);
  assert.deepEqual(ids(body.items), [mine.id]);
  assert.ok(!JSON.stringify(body).includes("Hidden restricted team card"));
});

void test("assigned-items-only hides a teammate's checklist item on a restricted board", async () => {
  const f = await seed();
  const day = localDateInTimezone(new Date(), "UTC");
  const teamCard = await addCard({ boardId: f.restrictedBoard.id, listId: f.homeList.id, title: "Team card", createdById: f.teammate.id, assigneeId: f.teammate.id });
  await addChecklistItem(teamCard.id, { text: "Hidden restricted team step", assigneeId: f.teammate.id, dueDateLocalDate: day, dueDateSlot: "anyTime", dueDateTimezone: "UTC" });
  const myCard = await addCard({ boardId: f.restrictedBoard.id, listId: f.homeList.id, title: "My card", createdById: f.teammate.id, assigneeId: f.viewer.id });
  const myItem = await addChecklistItem(myCard.id, { text: "My step", assigneeId: f.viewer.id, dueDateLocalDate: day, dueDateSlot: "anyTime", dueDateTimezone: "UTC" });

  const body = await today(f);
  assert.deepEqual(ids(body.items), [myItem.id]);
  assert.equal(body.counts.dueTodayChecklistItems, 1);
  assert.ok(!JSON.stringify(body).includes("Hidden restricted team step"));
});

void test("archived boards, cards and lists contribute nothing", async () => {
  const f = await seed();
  const day = localDateInTimezone(new Date(), "UTC");
  await addCard({ boardId: f.archivedBoard.id, listId: f.homeList.id, title: "Archived board card", createdById: f.viewer.id, assigneeId: f.viewer.id, dueDateLocalDate: day, dueDateSlot: "anyTime", dueDateTimezone: "UTC" });
  await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "Archived card", createdById: f.viewer.id, assigneeId: f.viewer.id, dueDateLocalDate: day, dueDateSlot: "anyTime", dueDateTimezone: "UTC", archivedAt: new Date() });
  await addCard({ boardId: f.sharedBoard.id, listId: f.archivedList.id, title: "Archived list card", createdById: f.viewer.id, assigneeId: f.viewer.id, dueDateLocalDate: day, dueDateSlot: "anyTime", dueDateTimezone: "UTC" });

  const body = await today(f);
  assert.deepEqual(body.items, []);
  assert.equal(body.counts.assignedCards, 0);
  assert.equal(body.counts.dueTodayCards, 0);
  // The archived board is excluded by the access resolver, so it is not even counted.
  assert.equal(body.boardCount, 4);
  assert.ok(!JSON.stringify(body).includes("Archived"));
});

void test("completed cards leave the horizon and the assigned count", async () => {
  const f = await seed();
  const day = localDateInTimezone(new Date(), "UTC");
  await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "Finished", createdById: f.viewer.id, assigneeId: f.viewer.id, dueDateLocalDate: day, dueDateSlot: "anyTime", dueDateTimezone: "UTC", completedAt: new Date() });
  const open = await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "Open", createdById: f.viewer.id, assigneeId: f.viewer.id, dueDateLocalDate: day, dueDateSlot: "anyTime", dueDateTimezone: "UTC" });

  const body = await today(f);
  assert.deepEqual(ids(body.items), [open.id]);
  assert.equal(body.counts.assignedCards, 1);
  assert.equal(body.counts.dueTodayCards, 1);
});

void test("completed_cards_active_days does not gate the trend", async () => {
  const f = await seed();
  // The workspace setting answers "does this completed card still render on a board", not "did I
  // finish it". A one-day window must not erase three-day-old completions from the trend.
  await db.update(workspaces).set({ completedCardsActiveDays: 1 }).where(eq(workspaces.id, f.homeWorkspace.id));
  const card = await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "Shipped", createdById: f.viewer.id, assigneeId: f.viewer.id, completedAt: new Date(Date.now() - 3 * 86_400_000) });
  await addCompletionActivity({
    boardId: f.sharedBoard.id,
    cardId: card.id,
    actorId: f.viewer.id,
    clientId: f.homeClient.id,
    createdAt: new Date(Date.now() - 3 * 86_400_000),
  });

  const body = await today(f);
  const total = body.trend.byDay.reduce((sum, day) => sum + day.completedCards, 0);
  assert.equal(total, 1);
});

void test("trend day bucketing follows the requested zone", async () => {
  const f = await seed();
  const card = await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "Late night ship", createdById: f.viewer.id, assigneeId: f.viewer.id });
  // Midday UTC yesterday: Kiritimati (+14) has already rolled to the next day, Niue (-11) has not.
  const at = new Date(Date.now() - 86_400_000);
  at.setUTCHours(12, 0, 0, 0);
  await addCompletionActivity({ boardId: f.sharedBoard.id, cardId: card.id, actorId: f.viewer.id, clientId: f.homeClient.id, createdAt: at });

  const kiritimati = await today(f, "Pacific/Kiritimati");
  const niue = await today(f, "Pacific/Niue");
  assert.equal(kiritimati.trend.byDay.length, 1);
  assert.equal(niue.trend.byDay.length, 1);
  assert.notEqual(kiritimati.trend.byDay[0]!.date, niue.trend.byDay[0]!.date);
});

void test("the trend counts both completion encodings and ignores un-completions", async () => {
  const f = await seed();
  const at = new Date(Date.now() - 86_400_000);
  const one = await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "Bulk completed", createdById: f.viewer.id, assigneeId: f.viewer.id });
  const two = await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "Toggled complete", createdById: f.viewer.id, assigneeId: f.viewer.id });
  const three = await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "Toggled back open", createdById: f.viewer.id, assigneeId: f.viewer.id });
  const four = await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "Reopened", createdById: f.viewer.id, assigneeId: f.viewer.id });
  const base = { boardId: f.sharedBoard.id, actorId: f.viewer.id, clientId: f.homeClient.id, createdAt: at };
  await addCompletionActivity({ ...base, cardId: one.id, action: ACTIVITY_ACTION.COMPLETED });
  await addCompletionActivity({ ...base, cardId: two.id, action: ACTIVITY_ACTION.COMPLETION_SET, payload: { toValue: true } });
  await addCompletionActivity({ ...base, cardId: three.id, action: ACTIVITY_ACTION.COMPLETION_SET, payload: { toValue: false } });
  await addCompletionActivity({ ...base, cardId: four.id, action: ACTIVITY_ACTION.UNCOMPLETED });

  const body = await today(f);
  const total = body.trend.byDay.reduce((sum, day) => sum + day.completedCards, 0);
  assert.equal(total, 2);
});

void test("a coalesced completion row contributes one, not its coalesced count", async () => {
  const f = await seed();
  // Guards `count(*)` against `sum(coalesced_count)`: the coalesced count folds in the toggles and
  // un-completions that produced the row, so summing it would credit un-completing a card as work.
  const card = await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "Toggled a lot", createdById: f.viewer.id, assigneeId: f.viewer.id });
  await addCompletionActivity({
    boardId: f.sharedBoard.id,
    cardId: card.id,
    actorId: f.viewer.id,
    clientId: f.homeClient.id,
    createdAt: new Date(Date.now() - 86_400_000),
    action: ACTIVITY_ACTION.COMPLETION_SET,
    payload: { toValue: true },
    coalescedCount: 7,
  });

  const body = await today(f);
  assert.equal(body.trend.byDay.reduce((sum, day) => sum + day.completedCards, 0), 1);
});

void test("feed-invisible activity matches My Cards history and remains in the trend", async () => {
  const f = await seed();
  const card = await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "Suppressed", createdById: f.viewer.id, assigneeId: f.viewer.id });
  await addCompletionActivity({
    boardId: f.sharedBoard.id,
    cardId: card.id,
    actorId: f.viewer.id,
    clientId: f.homeClient.id,
    createdAt: new Date(Date.now() - 86_400_000),
    feedVisible: false,
  });

  const body = await today(f);
  assert.equal(body.trend.byDay.reduce((sum, day) => sum + day.completedCards, 0), 1);
});

void test("checklist completions do not contribute to the completed-card trend", async () => {
  const f = await seed();
  const card = await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "Shared card", createdById: f.viewer.id, assigneeId: f.viewer.id });
  const at = new Date(Date.now() - 86_400_000);
  await addChecklistItem(card.id, { text: "I finished this", assigneeId: f.viewer.id, completedAt: at, completedById: f.viewer.id });
  // Assigned to the viewer but completed by someone else — it is the teammate's work, not theirs.
  await addChecklistItem(card.id, { text: "Teammate finished this", assigneeId: f.viewer.id, completedAt: at, completedById: f.teammate.id });

  const body = await today(f);
  assert.deepEqual(body.trend.byDay, []);
});

void test("archived cards do not contribute to the completed-card trend", async () => {
  const f = await seed();
  const at = new Date(Date.now() - 86_400_000);
  const card = await addCard({
    boardId: f.sharedBoard.id,
    listId: f.homeList.id,
    title: "Archived completion",
    createdById: f.viewer.id,
    assigneeId: f.viewer.id,
    completedAt: at,
    archivedAt: new Date(),
  });
  await addCompletionActivity({
    boardId: f.sharedBoard.id,
    cardId: card.id,
    actorId: f.viewer.id,
    clientId: f.homeClient.id,
    createdAt: at,
  });

  const body = await today(f);
  assert.deepEqual(body.trend.byDay, []);
});

void test("thisWeek and lastWeek split at the rolling seven-day boundary", async () => {
  const f = await seed();
  const card = await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "Steady work", createdById: f.viewer.id, assigneeId: f.viewer.id });
  const base = { boardId: f.sharedBoard.id, cardId: card.id, actorId: f.viewer.id, clientId: f.homeClient.id };
  // Noon anchors keep each stamp inside its intended local day regardless of when the suite runs.
  const atDaysAgo = (days: number) => {
    const at = new Date(Date.now() - days * 86_400_000);
    at.setUTCHours(12, 0, 0, 0);
    return at;
  };
  await addCompletionActivity({ ...base, createdAt: atDaysAgo(2) });
  await addCompletionActivity({ ...base, createdAt: atDaysAgo(9) });

  const body = await today(f);
  assert.equal(body.trend.thisWeek.completedCards, 1);
  assert.equal(body.trend.lastWeek.completedCards, 1);
  assert.equal(body.trend.days, 28);
});

void test("board navigation order breaks ties ahead of alphabetical board name", async () => {
  const f = await seed();
  const day = localDateInTimezone(new Date(), "UTC");
  const due = { dueDateLocalDate: day, dueDateSlot: "anyTime" as const, dueDateTimezone: "UTC" };
  // "Restricted" sits in a board group, so navigation order puts it ahead of "Shared" even though
  // it sorts later alphabetically. Both rows are otherwise identical on date and slot.
  const onShared = await addCard({ boardId: f.sharedBoard.id, listId: f.homeList.id, title: "A card", createdById: f.viewer.id, assigneeId: f.viewer.id, ...due });
  const onRestricted = await addCard({ boardId: f.restrictedBoard.id, listId: f.homeList.id, title: "Z card", createdById: f.viewer.id, assigneeId: f.viewer.id, ...due });
  // Same board, same date, same slot: cards rank before checklist items.
  const item = await addChecklistItem(onShared.id, { text: "A step", assigneeId: f.viewer.id, ...due });

  const body = await today(f);
  assert.deepEqual(ids(body.items), [onRestricted.id, onShared.id, item.id]);
});

void test("the horizon is capped while the counts stay exact", async () => {
  const f = await seed();
  const day = localDateInTimezone(new Date(), "UTC");
  const overdueDate = addDays(day, -2);
  const values = Array.from({ length: 105 }, (_, index) => ({
    boardId: f.sharedBoard.id,
    listId: f.homeList.id,
    title: `Overdue ${index}`,
    position: `${(index + 1) * 1000}.0000000000`,
    createdById: f.viewer.id,
    dueDateLocalDate: overdueDate,
    dueDateSlot: "anyTime" as const,
    dueDateTimezone: "UTC",
  }));
  const inserted = await db.insert(cards).values(values).returning();
  await db.insert(cardAssignees).values(inserted.map((card) => ({ cardId: card.id, userId: f.viewer.id })));

  const body = await today(f);
  assert.equal(body.items.length, 100);
  assert.equal(body.itemsTruncated, true);
  assert.equal(body.counts.overdueCards, 105);
});

void test("a viewer with no accessible boards gets a zeroed payload", async () => {
  const f = await seed();
  await db.delete(boardMembers).where(eq(boardMembers.userId, f.viewer.id));

  const body = await today(f);
  assert.equal(body.boardCount, 0);
  assert.deepEqual(body.items, []);
  assert.deepEqual(body.trend.byDay, []);
  assert.equal(body.counts.assignedCards, 0);
  assert.equal(body.counts.overdueCards, 0);
  assert.equal(body.timeZone, "UTC");
  assert.equal(body.today, localDateInTimezone(new Date(), "UTC"));
});

/**
 * Home is internal by construction: `homeRoutes` is registered only in server.ts, and the public
 * server's `/api/v1` scope is a closed hand-written list. This guards against a future contributor
 * adding it to public-api-server.ts by reflex.
 */
void test("the endpoint is absent from the public API server", async () => {
  const { buildPublicApiServer } = await import("../../public-api-server.js");
  const app = await buildPublicApiServer({
    enableWebhookDeliveryScheduler: false,
    logger: false,
    uploadsDir: testUploadsDir("test-public-uploads"),
  });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/home/today" });
    assert.equal(response.statusCode, 404);

    const spec = await app.inject({ method: "GET", url: "/openapi.json" });
    assert.equal(spec.statusCode, 200);
    assert.ok(!Object.keys(spec.json<{ paths: Record<string, unknown> }>().paths).includes("/home/today"));
  } finally {
    await app.close();
  }
});
