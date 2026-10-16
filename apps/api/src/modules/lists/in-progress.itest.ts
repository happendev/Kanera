import "../../test/setup.integration.js";
import type { CommitImportBody } from "@kanera/shared/dto";
import { activityEvents, automationInProgressRuns, boardMembers, boards, cardWatchers, notifications, cardAssignees, cardLabelAssignments, cardLabels, cards, lists, users, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { workingMs } from "@kanera/shared/time-in-progress";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { buildBoardExportArchive } from "../../lib/board-export.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { signupOwner } from "../../test/api-fixtures.js";
import { insertTestUsers } from "../../test/user-fixtures.js";
import { runInProgressAlertAutomationSweep } from "../../lib/automations.js";
import { runInProgressAlertNotificationSweep } from "../../lib/in-progress-alerts.js";
import { runKaneraBoardImport } from "../imports/kanera-importer.js";
import { agentWorkQueryRoutes } from "../work/routes.js";
import { parseKaneraBoardExport } from "../imports/kanera-parser.js";

/*
 * Time in progress lives in Postgres triggers (card_track_in_progress, list_backfill_in_progress), so
 * the behaviour a user sees depends on the database, not on any one route. This isolated test
 * exists because the E2E suite cannot age history: every E2E move happens seconds before the
 * assertion, so "started from the move history" and "started now" are indistinguishable there.
 *
 * Ways this can fail, each asserted below:
 *  1. The default workspace workflow is created without its "In Progress" flag.
 *  2. A card created directly in an in-progress list has no start.
 *  3. Moving into an in-progress list does not start the clock; moving out does not stop it.
 *  4. Moving between two in-progress lists restarts the clock (it must keep the original start).
 *  5. A same-list reorder or rename restarts or stops it; completing or archiving does not stop it,
 *     or reopening/unarchiving in an in-progress list does not restart it.
 *  6. The bulk "move all cards" path bypasses the rule.
 *  7. Flagging an existing list starts every clock "now" instead of from when each card entered it.
 *  8. Unflagging leaves stale starts behind, or drops the running stints instead of banking them.
 *  9. The board payload omits `inProgressSince`, so no client can render it.
 * 10. The move response omits the persisted start, so the mover's client keeps its own guess.
 * 11. A card written while its list's flag flips reads the old flag: a flagged list ends up with a
 *     card that has no start, or an unflagged list with one that does (no reload can repair it).
 * 12. Guarding (11) deadlocks against a card leaving, or being completed in, the list being flagged.
 * 13. A bulk "move all cards" records no per-card move, so flagging later dates those cards from
 *     creation instead of from when they arrived.
 * 14. Inserts: an explicit (imported) start is dropped, kept in a list that is not in progress, or
 *     allowed in the future.
 * 15. Export/import loses the list's flag, or restarts every imported clock.
 * 16. card_in_progress_too_long fires before the workspace alert, more than once per stint, for
 *     completed cards, or while the alert is off; or rearms without an admin correction.
 * 17. The work query's inProgressOnly filter includes completed or not-in-progress cards, the
 *     longest-in-progress sort misorders them, or agent source maps omit which lists are in progress.
 * 18. Time in progress is not cumulative: a stint that ends (leaving, completion, archiving) is lost
 *     instead of banked into in_progress_seconds, a later stint overwrites the total, or a move
 *     response / write path reports a clock that disagrees with the row.
 * 19. A write naming a watched column (list, completion, archive) overwrites the banked total.
 * 20. Tracked time is not working time (09:00-17:00 weekdays in the workspace's zone): SQL and the
 *     client's TypeScript disagree, a weekend or night counts, the zone is ignored or not editable.
 * 21. A workspace admin's correction of the tracked total is not applied, is open to non-admins,
 *     leaves no activity entry, or moves a running stint's start (and so its alert) when it need not.
 * 22. Card watchers are not told when a card passes the in-progress alert, are told more than once per
 *     card, including microsecond starts and concurrent sweeps, or fail to rearm after admin correction.
 */

type CardSummary = { id: string; listId: string; inProgressSince?: string | null };

void test("in-progress lists drive each card's time-in-progress start across every write path", async () => {
  const app = await buildIntegrationServer();
  const { user, auth } = await signupOwner(app, { orgName: "Acme Time In Progress", email: "owner-time-in-progress@example.com", displayName: "Owner" });

  const created = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Delivery" } });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<{ id: string }>();

  // 1. The default workflow comes from the Development Team template, which flags "In Progress".
  const workspaceLists = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id));
  const byName = new Map(workspaceLists.map((list) => [list.name, list]));
  assert.equal(byName.get("In Progress")?.inProgress, true);
  assert.equal(byName.get("Backlog")?.inProgress, false);
  const backlog = byName.get("Backlog")!;
  const inProgress = byName.get("In Progress")!;
  const readyForQa = byName.get("Ready for QA")!;

  const [board] = await db.insert(boards).values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" }).returning();
  assert.ok(board);

  const createCard = async (listId: string, title: string) => {
    const response = await app.inject({ method: "POST", url: `/boards/${board.id}/lists/${listId}/cards`, headers: auth, payload: { title } });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<{ id: string }>().id;
  };
  const move = async (cardId: string, listId: string) => {
    const response = await app.inject({ method: "POST", url: `/cards/${cardId}/move`, headers: auth, payload: { listId, afterCardId: null } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<{ inProgressSince: string | null }>();
  };
  const since = async (cardId: string) =>
    (await db.select({ since: cards.inProgressSince }).from(cards).where(eq(cards.id, cardId)))[0]?.since ?? null;

  // 2. Created directly in progress.
  const direct = await createCard(inProgress.id, "Created in progress");
  assert.ok(await since(direct));

  // 3. Into, and back out of, an in-progress list.
  const moving = await createCard(backlog.id, "Moves through the workflow");
  assert.equal(await since(moving), null);
  const moved = await move(moving, inProgress.id);
  const started = await since(moving);
  assert.ok(started);
  // 10. The response carries the persisted start.
  assert.equal(new Date(moved.inProgressSince!).getTime(), started.getTime());

  // 5. Same-list reorder and rename keep the start.
  await move(moving, inProgress.id);
  const renamed = await app.inject({ method: "PATCH", url: `/cards/${moving}`, headers: auth, payload: { title: "Renamed" } });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal((await since(moving))?.getTime(), started.getTime());

  // 4. Between two in-progress lists: one continuous stint.
  const flagged = await app.inject({ method: "PATCH", url: `/lists/${readyForQa.id}`, headers: auth, payload: { inProgress: true } });
  assert.equal(flagged.statusCode, 200, flagged.body);
  assert.equal(flagged.json<{ inProgress: boolean }>().inProgress, true);
  await move(moving, readyForQa.id);
  assert.equal((await since(moving))?.getTime(), started.getTime());

  const left = await move(moving, backlog.id);
  assert.equal(await since(moving), null);
  assert.equal(left.inProgressSince, null);
  // 18. Leaving banks the stint: the response reports the same total the row holds.
  const [afterLeaving] = await db.select({ seconds: cards.inProgressSeconds }).from(cards).where(eq(cards.id, moving));
  assert.equal((left as { inProgressSeconds?: number }).inProgressSeconds, afterLeaving?.seconds);

  // 6. Bulk list move follows the same rule.
  const bulkA = await createCard(backlog.id, "Bulk A");
  const bulkMoved = await app.inject({ method: "POST", url: `/lists/${backlog.id}/cards/move`, headers: auth, payload: { targetListId: inProgress.id, boardId: board.id } });
  assert.equal(bulkMoved.statusCode, 200, bulkMoved.body);
  assert.ok(await since(bulkA));

  // 7. Flagging an existing list dates each card from when it entered the list (the trigger-kept
  // `list_entered_at`; the migration seeded existing cards from move history), else creation.
  const awaiting = byName.get("Awaiting Feedback")!;
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  const [historic] = await db.insert(cards).values({
    listId: awaiting.id, boardId: board.id, title: "Waiting since Monday", position: "1000.0000000000", createdById: user.id, createdAt: tenDaysAgo, listEnteredAt: threeDaysAgo,
  }).returning();
  const [neverMoved] = await db.insert(cards).values({
    listId: awaiting.id, boardId: board.id, title: "Created here", position: "2000.0000000000", createdById: user.id, createdAt: tenDaysAgo,
  }).returning();
  assert.ok(historic && neverMoved);
  const flagAwaiting = await app.inject({ method: "PATCH", url: `/lists/${awaiting.id}`, headers: auth, payload: { inProgress: true } });
  assert.equal(flagAwaiting.statusCode, 200, flagAwaiting.body);
  assert.equal((await since(historic.id))?.getTime(), threeDaysAgo.getTime());
  assert.equal((await since(neverMoved.id))?.getTime(), tenDaysAgo.getTime());

  // 9. The board-open payload (what the web board hydrates from) carries it for clients.
  const boardPayload = await app.inject({ method: "POST", url: `/boards/${board.id}/open`, headers: auth });
  assert.equal(boardPayload.statusCode, 200, boardPayload.body);
  const summaries = boardPayload.json<{ cards: CardSummary[] }>().cards;
  assert.equal(
    new Date(summaries.find((card) => card.id === historic.id)!.inProgressSince!).getTime(),
    threeDaysAgo.getTime(),
  );

  // 8. Unflagging clears every start in the list and banks each running stint's working time, as if
  // every card had left progress at that moment.
  const unflaggedAt = Date.now();
  const unflag = await app.inject({ method: "PATCH", url: `/lists/${awaiting.id}`, headers: auth, payload: { inProgress: false } });
  assert.equal(unflag.statusCode, 200, unflag.body);
  assert.equal(await since(historic.id), null);
  assert.equal(await since(neverMoved.id), null);
  const [zone] = await db.select({ timeZone: workspaces.timeZone }).from(workspaces).where(eq(workspaces.id, workspace.id));
  for (const [cardId, start] of [[historic.id, threeDaysAgo], [neverMoved.id, tenDaysAgo]] as const) {
    const [unflagged] = await db.select({ seconds: cards.inProgressSeconds }).from(cards).where(eq(cards.id, cardId));
    const expected = workingMs(start.getTime(), unflaggedAt, zone!.timeZone) / 1000;
    assert.ok(Math.abs((unflagged?.seconds ?? 0) - expected) <= 5, `banked ${unflagged?.seconds}s, expected about ${expected}s`);
  }

  await app.close();
});

const DAY_MS = 24 * 60 * 60 * 1000;

async function setupWorkspace(email: string) {
  const app = await buildIntegrationServer();
  const { user, auth } = await signupOwner(app, { orgName: `Acme ${email}`, email, displayName: "Owner" });
  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: auth,
    payload: {
      name: "Races",
      lists: [{ name: "Todo", icon: "circle" }, { name: "Doing", icon: "progress", inProgress: true }, { name: "Review", icon: "eye" }, { name: "Done", icon: "circle-check" }],
      customFields: [],
      labels: [],
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const workspaceId = created.json<{ id: string }>().id;
  const workspaceLists = await db.select().from(lists).where(eq(lists.workspaceId, workspaceId));
  const list = (name: string) => workspaceLists.find((row) => row.name === name)!;
  const [board] = await db.insert(boards).values({ workspaceId, name: "Board", position: "1000.0000000000" }).returning();
  assert.ok(board);
  let position = 1000;
  const insertCard = async (listId: string, values: Partial<typeof cards.$inferInsert> = {}) => {
    position += 1000;
    const [card] = await db.insert(cards).values({
      listId, boardId: board.id, title: `Card ${position}`, position: `${position}.0000000000`, createdById: user.id, ...values,
    }).returning();
    return card!;
  };
  const read = async (cardId: string) => (await db.select().from(cards).where(eq(cards.id, cardId)))[0]!;
  return { app, auth, user, workspaceId, board, list, insertCard, read };
}

/** Resolves once `ms` pass without `promise` settling; rejects the test if it settles first. */
async function assertStillWaiting(promise: Promise<unknown>, ms = 300) {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, ms));
  assert.equal(settled, false, "expected the write to wait for the list's transaction");
}

void test("card writes serialize with a concurrent flag change of their list", async () => {
  const { app, list, insertCard, read } = await setupWorkspace("owner-in-progress-races@example.com");
  const todo = list("Todo");
  const review = list("Review");
  const done = list("Done");

  // 11a. Flagging holds the list; a card created in it meanwhile waits, then starts its clock.
  let release!: () => void;
  let written!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const flagWritten = new Promise<void>((resolve) => { written = resolve; });
  const flagging = db.transaction(async (tx) => {
    await tx.update(lists).set({ inProgress: true }).where(eq(lists.id, review.id));
    written();
    await gate;
  });
  await flagWritten;
  const inserting = insertCard(review.id);
  await assertStillWaiting(inserting);
  release();
  await flagging;
  assert.ok((await inserting).inProgressSince, "a card created while its list was flagged must have a start");

  // 11b. Unflagging holds the list; a card moved into it meanwhile waits, then has no start.
  const mover = await insertCard(todo.id);
  const gate2 = new Promise<void>((resolve) => { release = resolve; });
  const unflagWritten = new Promise<void>((resolve) => { written = resolve; });
  const unflagging = db.transaction(async (tx) => {
    await tx.update(lists).set({ inProgress: false }).where(eq(lists.id, review.id));
    written();
    await gate2;
  });
  await unflagWritten;
  const moving = db.update(cards).set({ listId: review.id }).where(eq(cards.id, mover.id)).returning();
  await assertStillWaiting(moving);
  release();
  await unflagging;
  await moving;
  assert.equal((await read(mover.id)).inProgressSince, null, "a card moved in while its list was unflagged must have no start");
  const stillThere = await db.select({ since: cards.inProgressSince }).from(cards).where(eq(cards.listId, review.id));
  assert.ok(stillThere.every((row) => row.since === null));

  // 12. A card leaving a list while that list is flagged: the flag waits for the card's row, the
  // card never waits for the source list, so both finish.
  const leaver = await insertCard(todo.id);
  const gate3 = new Promise<void>((resolve) => { release = resolve; });
  const moveWritten = new Promise<void>((resolve) => { written = resolve; });
  const leaving = db.transaction(async (tx) => {
    await tx.update(cards).set({ listId: done.id }).where(eq(cards.id, leaver.id));
    written();
    await gate3;
  });
  await moveWritten;
  const flaggingTodo = db.update(lists).set({ inProgress: true }).where(eq(lists.id, todo.id)).returning();
  await assertStillWaiting(flaggingTodo);
  release();
  await leaving;
  await flaggingTodo;
  assert.equal((await read(leaver.id)).inProgressSince, null);
  assert.equal((await read(mover.id)).listId, review.id);

  // 12b. Completing a card in a list while that list is flagged. The card's transaction already
  // holds its row (an earlier edit), the flag holds the list and waits for that row, and only then
  // does the completion fire the card trigger. Reading the flag with a lock there would wait for the
  // list: a deadlock. The flag then re-checks the card and leaves it, completed, without a start.
  const finisher = await insertCard(done.id);
  const gate4 = new Promise<void>((resolve) => { release = resolve; });
  const completeWritten = new Promise<void>((resolve) => { written = resolve; });
  const completing = db.transaction(async (tx) => {
    await tx.update(cards).set({ title: "Finishing" }).where(eq(cards.id, finisher.id));
    written();
    await gate4;
    await tx.update(cards).set({ completedAt: new Date() }).where(eq(cards.id, finisher.id));
  });
  await completeWritten;
  const flaggingDone = db.update(lists).set({ inProgress: true }).where(eq(lists.id, done.id)).returning();
  await assertStillWaiting(flaggingDone);
  release();
  await completing;
  await flaggingDone;
  assert.equal((await read(finisher.id)).inProgressSince, null);

  await app.close();
});

void test("flag backfills use the durable list entry time, inserts honour the start policy", async () => {
  const { app, auth, board, list, insertCard, read } = await setupWorkspace("owner-in-progress-entry@example.com");
  const todo = list("Todo");
  const doing = list("Doing");
  const review = list("Review");
  const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS);

  // 13. Created ten days ago, bulk-moved today: flagging dates it from today's arrival.
  const old = await insertCard(todo.id, { createdAt: tenDaysAgo });
  assert.equal(old.listEnteredAt.getTime(), tenDaysAgo.getTime(), "an insert enters its list when it was created");
  const beforeMove = Date.now();
  const bulk = await app.inject({ method: "POST", url: `/lists/${todo.id}/cards/move`, headers: auth, payload: { targetListId: review.id, boardId: board.id } });
  assert.equal(bulk.statusCode, 200, bulk.body);
  const flag = await app.inject({ method: "PATCH", url: `/lists/${review.id}`, headers: auth, payload: { inProgress: true } });
  assert.equal(flag.statusCode, 200, flag.body);
  const flaggedOld = await read(old.id);
  assert.ok(flaggedOld.inProgressSince!.getTime() >= beforeMove - 1000, "the start is the bulk move, not the card's creation");

  // 14. Insert policy.
  const threeDaysAgo = new Date(Date.now() - 3 * DAY_MS);
  const restored = await insertCard(doing.id, { inProgressSince: threeDaysAgo });
  assert.equal(restored.inProgressSince?.getTime(), threeDaysAgo.getTime(), "an explicit earlier start is kept");
  const outside = await insertCard(todo.id, { inProgressSince: threeDaysAgo });
  assert.equal(outside.inProgressSince, null, "no start outside an in-progress list");
  const future = await insertCard(doing.id, { inProgressSince: new Date(Date.now() + 5 * DAY_MS) });
  assert.ok(future.inProgressSince!.getTime() <= Date.now(), "a start is never in the future");
  // Finished work placed into an in-progress list does not run: the clock only runs for open work.
  const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS);
  const finished = await insertCard(doing.id, { completedAt: twoDaysAgo, inProgressSince: threeDaysAgo });
  assert.equal(finished.inProgressSince, null);
  // Inserts keep an explicit banked total (imports restore it) and never accept a negative one.
  const banked = await insertCard(todo.id, { inProgressSeconds: 3600 });
  assert.equal(banked.inProgressSeconds, 3600);

  await app.close();
});

void test("Kanera export and import keep in-progress lists and each card's start", async () => {
  const { app, user, workspaceId, board, list, insertCard } = await setupWorkspace("owner-in-progress-import@example.com");
  const doing = list("Doing");
  const todo = list("Todo");
  const threeDaysAgo = new Date(Date.now() - 3 * DAY_MS);
  const exported = await insertCard(doing.id, { title: "Mid-flight", inProgressSince: threeDaysAgo, inProgressSeconds: 7200 });

  // Through JSON and the upload parser, exactly as a downloaded file would arrive.
  const archive = parseKaneraBoardExport(JSON.parse(JSON.stringify(await buildBoardExportArchive(board.id, user.clientId)))).source;
  const storage = await getStorageForClient(user.clientId);
  const options: CommitImportBody["options"] = { includeArchived: false, importComments: false, importCustomFields: false, attachmentCopyMode: "skip" };
  const importInto = (lists: CommitImportBody["lists"]) => db.transaction((tx) => runKaneraBoardImport(tx, {
    source: archive,
    body: { board: { name: "Imported", icon: "layout-kanban" }, lists, labels: {}, customFields: {}, members: {}, options },
    workspaceId,
    clientId: user.clientId,
    actorId: user.id,
    storage,
  }));

  // 15a. Created lists keep the flag; the card keeps its three-day clock.
  const created = await importInto({ [doing.id]: { action: "create", icon: "progress" } });
  const [createdList] = await db.select().from(lists).where(eq(lists.id, created.createdLists[0]!.id));
  assert.equal(createdList?.inProgress, true);
  const [copy] = await db.select().from(cards).where(eq(cards.boardId, created.board.id));
  assert.equal(copy?.title, exported.title);
  assert.equal(copy?.inProgressSince?.getTime(), threeDaysAgo.getTime());
  assert.equal(copy?.inProgressSeconds, 7200, "the banked total from earlier stints carries over");

  // 15b. Mapped onto a list that is not in progress: the target's classification wins.
  const mapped = await importInto({ [doing.id]: { action: "map", targetListId: todo.id } });
  const [mappedCopy] = await db.select().from(cards).where(eq(cards.boardId, mapped.board.id));
  assert.equal(mappedCopy?.inProgressSince, null);
  assert.equal(mappedCopy?.inProgressSeconds, 7200, "history is kept even when the target list is not in progress");

  await app.close();
});

void test("card_in_progress_too_long stays latched until an admin lowers tracked time", async () => {
  const { app, auth, workspaceId, list, insertCard, read } = await setupWorkspace("owner-in-progress-alert@example.com");
  const doing = list("Doing");
  const todo = list("Todo");
  const [label] = await db.insert(cardLabels).values({ workspaceId, name: "Stuck", position: "1000.0000000000" }).returning();
  assert.ok(label);
  const created = await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/automations`,
    headers: auth,
    payload: { enabled: true, triggerType: "card_in_progress_too_long", actions: [{ type: "add_labels", config: { labelIds: [label.id] } }] },
  });
  assert.equal(created.statusCode, 201, created.body);
  const automationId = created.json<{ id: string }>().id;
  const labelled = async () => (await db.select({ cardId: cardLabelAssignments.cardId }).from(cardLabelAssignments)
    .where(eq(cardLabelAssignments.labelId, label.id))).map((row) => row.cardId).sort();
  const ledger = async (cardId: string) => (await db.select().from(automationInProgressRuns)
    .where(and(eq(automationInProgressRuns.automationId, automationId), eq(automationInProgressRuns.cardId, cardId))))[0] ?? null;

  const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS);
  const stuck = await insertCard(doing.id, { inProgressSince: tenDaysAgo });
  const fresh = await insertCard(doing.id);
  await insertCard(doing.id, { inProgressSince: tenDaysAgo, completedAt: new Date() });

  // Default alert (7 days): only the open card ten days in fires; the fresh and completed ones do not.
  assert.equal(await runInProgressAlertAutomationSweep(undefined, new Date()), 1);
  assert.deepEqual(await labelled(), [stuck.id]);
  assert.equal((await ledger(stuck.id))?.alertAt.getTime(), tenDaysAgo.getTime() + 7 * DAY_MS);
  // Once per stint: the ledger, not the label, stops the hourly sweep repeating it.
  await db.delete(cardLabelAssignments).where(eq(cardLabelAssignments.labelId, label.id));
  assert.equal(await runInProgressAlertAutomationSweep(undefined, new Date()), 0);

  // Leaving and re-entering progress does not rearm a previously alerted card.
  await db.update(cards).set({ listId: todo.id }).where(eq(cards.id, stuck.id));
  await db.update(cards).set({ listId: doing.id }).where(eq(cards.id, stuck.id));
  assert.ok((await read(stuck.id)).inProgressSince);
  assert.equal(await runInProgressAlertAutomationSweep(undefined, new Date()), 0);
  const nextWeek = new Date(Date.now() + 8 * DAY_MS);
  assert.equal(await runInProgressAlertAutomationSweep(undefined, nextWeek), 1);
  assert.deepEqual(await labelled(), [fresh.id]);
  const reset = await app.inject({ method: "PUT", url: `/cards/${stuck.id}/in-progress-time`, headers: auth, payload: { seconds: 0 } });
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal(await ledger(stuck.id), null);
  assert.equal(await runInProgressAlertAutomationSweep(undefined, nextWeek), 1);
  assert.equal(await runInProgressAlertAutomationSweep(undefined, nextWeek), 0);

  // 0 turns the alert, and so the trigger, off.
  const off = await app.inject({ method: "PATCH", url: `/workspaces/${workspaceId}`, headers: auth, payload: { inProgressAlertDays: 0 } });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json<{ inProgressAlertDays: number }>().inProgressAlertDays, 0);
  await insertCard(doing.id, { inProgressSince: tenDaysAgo });
  assert.equal(await runInProgressAlertAutomationSweep(undefined, new Date()), 0);

  await app.close();
});

void test("work queries filter and sort by time in progress, and agent sources mark in-progress lists", async () => {
  const { app, auth, user, workspaceId, list, insertCard } = await setupWorkspace("owner-in-progress-query@example.com");
  const doing = list("Doing");
  const todo = list("Todo");
  const assign = async (card: { id: string }) => { await db.insert(cardAssignees).values({ cardId: card.id, userId: user.id }); };
  const oldest = await insertCard(doing.id, { title: "Started three days ago", inProgressSince: new Date(Date.now() - 3 * DAY_MS) });
  const newest = await insertCard(doing.id, { title: "Started yesterday", inProgressSince: new Date(Date.now() - DAY_MS) });
  const waiting = await insertCard(todo.id, { title: "Not started" });
  const finished = await insertCard(doing.id, { title: "Finished in Doing", completedAt: new Date() });
  for (const card of [oldest, newest, waiting, finished]) await assign(card);

  const query = async (sort: string, filters: Record<string, unknown>) => {
    const response = await app.inject({ method: "POST", url: "/work/cards/query", headers: auth, payload: { lens: "my", filters, sort } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<{ cards: { id: string }[] }>().cards.map((card) => card.id);
  };
  // Filter: open work in In progress lists only.
  assert.deepEqual(await query("inProgressAsc", { inProgressOnly: true }), [oldest.id, newest.id]);
  assert.deepEqual(await query("inProgressDesc", { inProgressOnly: true }), [newest.id, oldest.id]);
  // Sort alone: cards not in progress sort last in either direction.
  const all = await query("inProgressAsc", { completion: "active" });
  assert.deepEqual(all, [oldest.id, newest.id, waiting.id]);

  // "Too long" reads the current stint against the workspace alert, as the board's amber clock does,
  // and Portfolio counts exactly what that drill-down returns.
  await db.update(workspaces).set({ inProgressAlertDays: 2 }).where(eq(workspaces.id, workspaceId));
  assert.deepEqual(await query("inProgressAsc", { inProgressTooLongOnly: true }), [oldest.id]);
  const portfolio = await app.inject({ method: "POST", url: "/work/portfolio/query", headers: auth, payload: { days: 30, timeZone: "UTC" } });
  assert.equal(portfolio.statusCode, 200, portfolio.body);
  const totals = portfolio.json<{ totals: { inProgress: number; inProgressTooLong: number } }>().totals;
  assert.deepEqual({ inProgress: totals.inProgress, inProgressTooLong: totals.inProgressTooLong }, { inProgress: 2, inProgressTooLong: 1 });
  // An alert of 0 turns the signal off everywhere.
  await db.update(workspaces).set({ inProgressAlertDays: 0 }).where(eq(workspaces.id, workspaceId));
  assert.deepEqual(await query("inProgressAsc", { inProgressTooLongOnly: true }), []);

  // Agents read the same filter and see which source lists are in progress.
  const agentApp = await buildIntegrationServer();
  await agentApp.register(agentWorkQueryRoutes, { prefix: "/agent-public" });
  const agent = await agentApp.inject({ method: "POST", url: "/agent-public/work/cards/query", headers: auth, payload: { lens: "my", filters: { inProgressOnly: true }, sort: "inProgressAsc" } });
  assert.equal(agent.statusCode, 200, agent.body);
  const body = agent.json<{ cards: { id: string }[]; sources: { lists: { id: string; inProgress: boolean }[] } }>();
  assert.deepEqual(body.cards.map((card) => card.id), [oldest.id, newest.id]);
  assert.deepEqual(body.sources.lists.map((row) => ({ id: row.id, inProgress: row.inProgress })), [{ id: doing.id, inProgress: true }]);

  await agentApp.close();
  await app.close();
});

void test("time in progress accumulates across stints, completion and archiving", async () => {
  const { app, auth, workspaceId, board, list, insertCard, read } = await setupWorkspace("owner-in-progress-cumulative@example.com");
  // Tracked time is working time (09:00-17:00 weekdays). Every stint below lasts whole weeks, and any
  // 7 x 24 hours in a zone without DST holds exactly 40 working hours, so the totals do not depend
  // on when the test runs.
  await db.update(workspaces).set({ timeZone: "UTC" }).where(eq(workspaces.id, workspaceId));
  const todo = list("Todo");
  const doing = list("Doing");
  const review = list("Review");
  const move = async (cardId: string, listId: string) => {
    const response = await app.inject({ method: "POST", url: `/cards/${cardId}/move`, headers: auth, payload: { listId, afterCardId: null } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<{ inProgressSince: string | null; inProgressSeconds: number }>();
  };
  const setCompleted = async (cardId: string, completed: boolean) => {
    const response = await app.inject({ method: "PATCH", url: `/cards/${cardId}/completion`, headers: auth, payload: { completed } });
    assert.equal(response.statusCode, 200, response.body);
  };
  // Ages the running stint without firing the card trigger (only clock columns are written).
  const startedAgo = async (cardId: string, ms: number) => {
    await db.update(cards).set({ inProgressSince: new Date(Date.now() - ms) }).where(eq(cards.id, cardId));
  };
  const WEEK_MS = 7 * DAY_MS;
  const WEEK_S = 40 * 3600;
  const near = (actual: number, expectedSeconds: number) =>
    assert.ok(Math.abs(actual - expectedSeconds) <= 5, `expected ~${expectedSeconds}s, got ${actual}s`);

  const card = await insertCard(todo.id);
  assert.equal(card.inProgressSeconds, 0);

  // 18a. First stint: a week in Doing, then out to Review (not in progress) banks it.
  await move(card.id, doing.id);
  await startedAgo(card.id, WEEK_MS);
  const out = await move(card.id, review.id);
  assert.equal(out.inProgressSince, null);
  near(out.inProgressSeconds, WEEK_S);
  near((await read(card.id)).inProgressSeconds, WEEK_S);

  // 18b. A second stint adds to, rather than replaces, the total.
  await move(card.id, doing.id);
  await startedAgo(card.id, 2 * WEEK_MS);
  await move(card.id, todo.id);
  near((await read(card.id)).inProgressSeconds, 3 * WEEK_S);

  // 18c. Completing in an in-progress list ends the stint; reopening there starts a new one.
  await move(card.id, doing.id);
  await startedAgo(card.id, WEEK_MS);
  await setCompleted(card.id, true);
  const completed = await read(card.id);
  assert.equal(completed.inProgressSince, null);
  near(completed.inProgressSeconds, 4 * WEEK_S);
  // A completed card moved into progress does not run.
  await move(card.id, review.id);
  await move(card.id, doing.id);
  assert.equal((await read(card.id)).inProgressSince, null);
  const reopenedAt = Date.now();
  await setCompleted(card.id, false);
  const reopened = await read(card.id);
  assert.ok(reopened.inProgressSince && reopened.inProgressSince.getTime() >= reopenedAt - 1000, "reopening in progress starts a new stint");
  near(reopened.inProgressSeconds, 4 * WEEK_S);

  // 18d. Archiving banks; unarchiving in an in-progress list restarts.
  await startedAgo(card.id, WEEK_MS);
  await db.update(cards).set({ archivedAt: new Date() }).where(eq(cards.id, card.id));
  const archived = await read(card.id);
  assert.equal(archived.inProgressSince, null);
  near(archived.inProgressSeconds, 5 * WEEK_S);
  await db.update(cards).set({ archivedAt: null }).where(eq(cards.id, card.id));
  assert.ok((await read(card.id)).inProgressSince);

  // 19. A write naming a watched column cannot overwrite the clock.
  await db.update(cards).set({ listId: doing.id, inProgressSeconds: 1, inProgressSince: null }).where(eq(cards.id, card.id));
  const guarded = await read(card.id);
  assert.ok(guarded.inProgressSince, "the running stint survives");
  near(guarded.inProgressSeconds, 5 * WEEK_S);

  // The board payload carries the total so every client can render it.
  const boardPayload = await app.inject({ method: "POST", url: `/boards/${board.id}/open`, headers: auth });
  assert.equal(boardPayload.statusCode, 200, boardPayload.body);
  const summary = boardPayload.json<{ cards: { id: string; inProgressSeconds?: number }[] }>().cards.find((row) => row.id === card.id);
  near(summary?.inProgressSeconds ?? 0, 5 * WEEK_S);

  await app.close();
});

void test("tracked time counts working hours in the workspace's time zone", async () => {
  const { app, auth, user, workspaceId, list, insertCard } = await setupWorkspace("owner-in-progress-working-hours@example.com");
  const todo = list("Todo");
  const doing = list("Doing");

  // 20a. The rule, on fixed instants: SQL (which banks stints) and TypeScript (which clients use for
  // the running stint) must agree, or a card's time jumps when its stint is banked.
  const cases: { start: string; stop: string; zone: string; hours: number }[] = [
    { start: "2026-09-25T09:00:00Z", stop: "2026-09-28T09:00:00Z", zone: "UTC", hours: 8 }, // Fri 9am to Mon 9am
    { start: "2026-09-14T00:00:00Z", stop: "2026-09-28T00:00:00Z", zone: "UTC", hours: 80 }, // two weeks
    { start: "2026-09-26T08:00:00Z", stop: "2026-09-27T20:00:00Z", zone: "UTC", hours: 0 }, // a weekend
    { start: "2026-09-29T17:00:00Z", stop: "2026-09-30T10:00:00Z", zone: "UTC", hours: 1 }, // overnight
    { start: "2026-09-29T07:00:00Z", stop: "2026-09-29T08:00:00Z", zone: "Africa/Johannesburg", hours: 1 }, // 09:00-10:00 local
    { start: "2026-11-02T13:00:00Z", stop: "2026-11-02T23:00:00Z", zone: "America/New_York", hours: 8 }, // the day after DST ends
    { start: "2026-09-29T07:00:00Z", stop: "2026-09-29T10:00:00Z", zone: "Not/AZone", hours: 1 }, // unknown zone: UTC
  ];
  for (const example of cases) {
    const result = await db.execute<{ seconds: number }>(
      sql`select in_progress_working_seconds(${example.start}::timestamptz, ${example.stop}::timestamptz, ${example.zone}) as seconds`,
    );
    const row = result.rows[0];
    const label = `${example.start} -> ${example.stop} in ${example.zone}`;
    assert.equal(Number(row?.seconds), example.hours * 3600, `SQL ${label}`);
    assert.equal(workingMs(Date.parse(example.start), Date.parse(example.stop), example.zone), example.hours * 3600 * 1000, `TypeScript ${label}`);
  }

  // 20b. New workspaces take their creator's zone; an admin can change it; an unknown zone is refused.
  const [owner] = await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, user.id));
  const [workspace] = await db.select({ timeZone: workspaces.timeZone }).from(workspaces).where(eq(workspaces.id, workspaceId));
  assert.equal(workspace?.timeZone, owner?.timezone);
  const rejected = await app.inject({ method: "PATCH", url: `/workspaces/${workspaceId}`, headers: auth, payload: { timeZone: "Mars/Olympus_Mons" } });
  assert.equal(rejected.statusCode, 400, rejected.body);
  const changed = await app.inject({ method: "PATCH", url: `/workspaces/${workspaceId}`, headers: auth, payload: { timeZone: "Asia/Kolkata" } });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json<{ timeZone: string }>().timeZone, "Asia/Kolkata");

  // 20c. The trigger banks in the workspace's zone: a week in progress is 40 hours in Kolkata (no DST).
  const card = await insertCard(todo.id);
  const moved = await app.inject({ method: "POST", url: `/cards/${card.id}/move`, headers: auth, payload: { listId: doing.id, afterCardId: null } });
  assert.equal(moved.statusCode, 200, moved.body);
  await db.update(cards).set({ inProgressSince: new Date(Date.now() - 7 * DAY_MS) }).where(eq(cards.id, card.id));
  const out = await app.inject({ method: "POST", url: `/cards/${card.id}/move`, headers: auth, payload: { listId: todo.id, afterCardId: null } });
  assert.equal(out.statusCode, 200, out.body);
  const banked = out.json<{ inProgressSeconds: number }>().inProgressSeconds;
  assert.ok(Math.abs(banked - 40 * 3600) <= 5, `expected ~40h, got ${banked}s`);

  await app.close();
});

void test("workspace admins correct a card's tracked time in progress, with an activity entry", async () => {
  const { app, auth, user, workspaceId, board, list, insertCard, read } = await setupWorkspace("owner-in-progress-correct@example.com");
  const doing = list("Doing");
  const card = await insertCard(doing.id);
  // A running stint that started two weeks ago, in UTC, so it has tracked exactly 80 working hours.
  await db.update(workspaces).set({ timeZone: "UTC" }).where(eq(workspaces.id, workspaceId));
  const start = new Date(Date.now() - 14 * DAY_MS);
  await db.update(cards).set({ inProgressSince: start, inProgressSeconds: 600 }).where(eq(cards.id, card.id));
  const running = Math.floor(workingMs(start.getTime(), Date.now(), "UTC") / 1000);

  // A member who is not a workspace admin is refused.
  const [member] = await insertTestUsers(db, { clientId: user.clientId, email: "member-in-progress-correct@example.com", passwordHash: "x", displayName: "Member" }).returning();
  await db.insert(workspaceMembers).values({ workspaceId, userId: member!.id, role: "member" });
  await db.insert(boardMembers).values({ boardId: board.id, userId: member!.id, role: "editor" });
  const memberAuth = { authorization: `Bearer ${app.jwt.sign({ sub: member!.id, cid: user.clientId, role: "member" })}` };
  const refused = await app.inject({ method: "PUT", url: `/cards/${card.id}/in-progress-time`, headers: memberAuth, payload: { seconds: 3600 } });
  assert.equal(refused.statusCode, 403, refused.body);

  // Above what the running stint has tracked: the stint keeps its start, the bank absorbs the rest.
  const target = running + 7200;
  const raised = await app.inject({ method: "PUT", url: `/cards/${card.id}/in-progress-time`, headers: auth, payload: { seconds: target } });
  assert.equal(raised.statusCode, 200, raised.body);
  let row = await read(card.id);
  assert.equal(row.inProgressSince?.getTime(), start.getTime());
  assert.ok(Math.abs(row.inProgressSeconds - 7200) <= 5, `banked ${row.inProgressSeconds}`);
  const [entry] = await db.select().from(activityEvents)
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, "inProgressTime:set")));
  assert.ok(entry);
  const payload = entry.payload as { fromSeconds: number; toSeconds: number };
  assert.equal(payload.toSeconds, target);
  assert.ok(Math.abs(payload.fromSeconds - (running + 600)) <= 5, `from ${payload.fromSeconds}`);

  // Below it: the stint restarts now from the corrected total.
  const lowered = await app.inject({ method: "PUT", url: `/cards/${card.id}/in-progress-time`, headers: auth, payload: { seconds: 3600 } });
  assert.equal(lowered.statusCode, 200, lowered.body);
  row = await read(card.id);
  assert.equal(row.inProgressSeconds, 3600);
  assert.ok(row.inProgressSince && Date.now() - row.inProgressSince.getTime() < 60_000);

  // A stopped clock stays stopped; the correction only sets the total.
  await db.update(cards).set({ completedAt: new Date() }).where(eq(cards.id, card.id));
  const stopped = await app.inject({ method: "PUT", url: `/cards/${card.id}/in-progress-time`, headers: auth, payload: { seconds: 5400 } });
  assert.equal(stopped.statusCode, 200, stopped.body);
  row = await read(card.id);
  assert.equal(row.inProgressSince, null);
  assert.equal(row.inProgressSeconds, 5400);

  await app.close();
});

void test("card watchers receive one durable alert until an admin lowers time below the threshold", async () => {
  const { app, auth, user, workspaceId, board, list, insertCard } = await setupWorkspace("owner-in-progress-notify@example.com");
  await db.update(workspaces).set({ inProgressAlertDays: 2 }).where(eq(workspaces.id, workspaceId));
  const card = await insertCard(list("Doing").id);
  const [watcher] = await insertTestUsers(db, { clientId: user.clientId, email: "watcher-in-progress-notify@example.com", passwordHash: "x", displayName: "Watcher" }).returning();
  await db.insert(workspaceMembers).values({ workspaceId, userId: watcher!.id, role: "member" });
  await db.insert(boardMembers).values({ boardId: board.id, userId: watcher!.id, role: "editor" });
  await db.insert(cardWatchers).values({ cardId: card.id, userId: watcher!.id });
  const alerts = async () => db.select().from(activityEvents)
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, "inProgress:tooLong")));
  const watcherNotifications = async () => {
    // Fan-out runs on a background queue after the activity is published; wait for it to land.
    for (let attempt = 0; attempt < 50; attempt++) {
      const rows = await db.select().from(notifications).where(and(eq(notifications.userId, watcher!.id), eq(notifications.cardId, card.id)));
      if (rows.length > 0) return rows;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return [];
  };

  // Inside the alert window: nothing yet.
  await db.update(cards).set({ inProgressSince: new Date(Date.now() - DAY_MS) }).where(eq(cards.id, card.id));
  await runInProgressAlertNotificationSweep();
  assert.equal((await alerts()).length, 0);

  // Past it: one system activity for this stint, delivered to the watcher.
  const firstStart = new Date(Date.now() - 3 * DAY_MS);
  // Postgres starts have microseconds, unlike JS Date: equality used to repeat every hour.
  await db.update(cards).set({ inProgressSince: sql`${firstStart.toISOString()}::timestamptz + interval '123 microseconds'` }).where(eq(cards.id, card.id));
  await Promise.all([runInProgressAlertNotificationSweep(), runInProgressAlertNotificationSweep()]);
  const [first] = await alerts();
  assert.ok(first);
  assert.equal(first.actorKind, "system");
  assert.deepEqual(first.payload, { inProgressSince: firstStart.toISOString(), alertDays: 2 });
  const delivered = await watcherNotifications();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]!.activityId, first.id);
  assert.equal(delivered[0]!.reason, "watching");

  // Once per stint, however often the sweep runs.
  await runInProgressAlertNotificationSweep();
  assert.equal((await alerts()).length, 1);

  // Moving to another stint and changing the setting do not rearm the alert.
  await db.update(cards).set({ inProgressSince: new Date(Date.now() - 4 * DAY_MS) }).where(eq(cards.id, card.id));
  await runInProgressAlertNotificationSweep();
  assert.equal((await alerts()).length, 1);
  await db.update(workspaces).set({ inProgressAlertDays: 1 }).where(eq(workspaces.id, workspaceId));
  await runInProgressAlertNotificationSweep();
  assert.equal((await alerts()).length, 1);

  // Neither increasing the total nor reducing it while still above the threshold rearms it.
  for (const seconds of [10 * 86400, 9 * 86400]) {
    const correction = await app.inject({ method: "PUT", url: `/cards/${card.id}/in-progress-time`, headers: auth, payload: { seconds } });
    assert.equal(correction.statusCode, 200, correction.body);
    await runInProgressAlertNotificationSweep();
    assert.equal((await alerts()).length, 1);
  }

  const reset = await app.inject({ method: "PUT", url: `/cards/${card.id}/in-progress-time`, headers: auth, payload: { seconds: 0 } });
  assert.equal(reset.statusCode, 200, reset.body);
  await runInProgressAlertNotificationSweep();
  assert.equal((await alerts()).length, 1);
  await db.update(cards).set({ inProgressSince: new Date(Date.now() - 3 * DAY_MS) }).where(eq(cards.id, card.id));
  await Promise.all([runInProgressAlertNotificationSweep(), runInProgressAlertNotificationSweep()]);
  assert.equal((await alerts()).length, 2);
  await runInProgressAlertNotificationSweep();
  assert.equal((await alerts()).length, 2);

  // History retention must not rearm the durable claim.
  await db.delete(activityEvents).where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, "inProgress:tooLong")));
  await runInProgressAlertNotificationSweep();
  assert.equal((await alerts()).length, 0);

  // The alert set to 0 turns it off.
  await db.update(workspaces).set({ inProgressAlertDays: 0 }).where(eq(workspaces.id, workspaceId));
  await db.update(cards).set({ inProgressSince: new Date(Date.now() - 5 * DAY_MS) }).where(eq(cards.id, card.id));
  await runInProgressAlertNotificationSweep();
  assert.equal((await alerts()).length, 0);

  await app.close();
});

// E2E sees seconds of elapsed time only. These assertions catch lost banked working hours,
// disabled-time backfill and resumed clocks starting from old history instead of the enable time.
void test("organisation and board progress gates bank time and exclude disabled intervals", async () => {
  const app = await buildIntegrationServer();
  const { auth, user } = await signupOwner(app, { orgName: "Progress gates", email: "progress-gates@example.com", displayName: "Owner" });
  const created = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Gates" } });
  assert.equal(created.statusCode, 201, created.body);
  const workspaceId = created.json<{ id: string }>().id;
  const [list] = await db.select().from(lists).where(and(eq(lists.workspaceId, workspaceId), eq(lists.inProgress, true)));
  assert.ok(list);
  const response = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/boards`, headers: auth, payload: { name: "Gated" } });
  assert.equal(response.statusCode, 201, response.body);
  const boardId = response.json<{ id: string }>().id;
  const [card] = await db.insert(cards).values({ workspaceId, boardId, listId: list.id, title: "Clock", createdById: user.id, position: "1000" }).returning();
  assert.ok(card);
  const read = async () => (await db.select().from(cards).where(eq(cards.id, card.id)))[0]!;
  const patch = async (url: string, inProgressEnabled: boolean) => {
    const res = await app.inject({ method: "PATCH", url, headers: auth, payload: { inProgressEnabled } });
    assert.equal(res.statusCode, 200, res.body);
  };
  await db.update(cards).set({ inProgressSince: new Date("2026-01-05T09:00:00Z"), inProgressSeconds: 600 }).where(eq(cards.id, card.id));
  await patch(`/boards/${boardId}`, false);
  const stopped = await read();
  assert.equal(stopped.inProgressSince, null);
  assert.ok(stopped.inProgressSeconds > 600, "completed working hours are banked");
  await db.update(lists).set({ inProgress: false }).where(eq(lists.id, list.id));
  await db.update(lists).set({ inProgress: true }).where(eq(lists.id, list.id));
  assert.equal((await read()).inProgressSince, null, "list backfill respects board opt-out");
  await patch("/clients/me", false);
  await patch(`/boards/${boardId}`, true);
  assert.equal((await read()).inProgressSince, null, "organisation off wins over board on");
  const correction = await app.inject({ method: "PUT", url: `/cards/${card.id}/in-progress-time`, headers: auth, payload: { seconds: 1 } });
  assert.equal(correction.statusCode, 403);
  assert.equal(await runInProgressAlertNotificationSweep(), 0);
  assert.equal(await runInProgressAlertAutomationSweep(), 0);
  const resumeAfter = Date.now();
  await patch("/clients/me", true);
  const resumed = await read();
  assert.ok(resumed.inProgressSince && resumed.inProgressSince.getTime() >= resumeAfter);
  assert.equal(resumed.inProgressSeconds, stopped.inProgressSeconds);
  await db.update(lists).set({ inProgress: false }).where(eq(lists.id, list.id));
  await db.update(lists).set({ inProgress: true }).where(eq(lists.id, list.id));
  assert.ok((await read()).inProgressSince!.getTime() >= resumeAfter, "list backfill cannot count the disabled interval");
  await patch(`/boards/${boardId}`, false);
  await patch("/clients/me", false);
  await patch("/clients/me", true);
  assert.equal((await read()).inProgressSince, null, "org enable retains individual board opt-outs");
});

// A browser cannot hold a transaction across a settings toggle. Prove that a card inserted while
// the organisation switch is uncommitted reads the committed setting after waiting on its board.
void test("cards created during an organisation toggle use the committed progress setting", async () => {
  const { workspaceId, insertCard, list } = await setupWorkspace("progress-org-race@example.com");
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  assert.ok(workspace);
  let release!: () => void;
  let written!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { written = resolve; });
  const toggling = db.transaction(async (tx) => {
    await tx.execute(sql`update client set in_progress_enabled = false where id = ${workspace.clientId}`);
    written();
    await gate;
  });
  await ready;
  const inserting = insertCard(list("Doing").id);
  try { await assertStillWaiting(inserting); }
  finally { release(); }
  await toggling;
  assert.equal((await inserting).inProgressSince, null);
});
