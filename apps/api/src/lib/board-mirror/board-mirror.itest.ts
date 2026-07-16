import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityEvents,
  boardMembers,
  boardMirrorDirtyCards,
  boardMirrors,
  boards,
  cardAssignees,
  cardAttachments,
  cardChecklistItems,
  cardChecklists,
  cardCustomFieldValues,
  cardLabelAssignments,
  cardLabels,
  cards,
  comments,
  customFields,
  eventOutbox,
  externalLinks,
  lists,
  users,
  workspaceMembers,
} from "@kanera/shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { processBoardMirrors } from "./drain.js";

async function waitForOutboxEvent(boardId: string, eventType: (typeof eventOutbox.$inferSelect)["eventType"]) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [row] = await db.select({ id: eventOutbox.id }).from(eventOutbox).where(and(eq(eventOutbox.boardId, boardId), eq(eventOutbox.eventType, eventType))).limit(1);
    if (row) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${eventType} outbox row`);
}

async function waitForNewOutboxEvent(boardId: string, eventType: (typeof eventOutbox.$inferSelect)["eventType"], previousCount: number) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await db.select({ id: eventOutbox.id }).from(eventOutbox).where(and(eq(eventOutbox.boardId, boardId), eq(eventOutbox.eventType, eventType)));
    if (rows.length > previousCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for a new ${eventType} outbox row`);
}

void test("mirror worker starts at now, links new in-scope cards, and snapshots eligible assignees", async () => {
  const app = await buildIntegrationServer();
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { orgName: "Worker Org", email: "worker-owner@example.com", password: "Abc12345", displayName: "Owner" } });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string; clientId: string } }>();
  const auth = { authorization: `Bearer ${accessToken}` };
  const workspaceResponse = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Delivery" } });
  const workspace = workspaceResponse.json<{ id: string }>();
  const workspaceLists = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).orderBy(lists.position);
  const sourceList = workspaceLists[0]!;
  const [source, target] = await db.insert(boards).values([
    { workspaceId: workspace.id, name: "Source", position: "1000.0000000000" },
    { workspaceId: workspace.id, name: "Target", position: "2000.0000000000" },
  ]).returning();
  await db.insert(boardMembers).values([
    { boardId: source!.id, userId: user.id, role: "editor" },
    { boardId: target!.id, userId: user.id, role: "editor" },
  ]);
  const [oldCard] = await db.insert(cards).values({ listId: sourceList.id, boardId: source!.id, title: "Pre-existing", position: "1000.0000000000", createdById: user.id }).returning();

  const mirrorResponse = await app.inject({ method: "POST", url: `/boards/${source!.id}/mirrors`, headers: auth, payload: { targetBoardId: target!.id, lists: [{ sourceListId: sourceList.id }] } });
  assert.equal(mirrorResponse.statusCode, 201, mirrorResponse.body);
  const mirror = mirrorResponse.json<{ id: string }>();
  await processBoardMirrors();
  assert.equal((await db.select().from(externalLinks).where(and(eq(externalLinks.provider, `mirror:${mirror.id}`), eq(externalLinks.externalId, oldCard!.id)))).length, 0, "create must not backfill existing cards");

  const outOfScope = await app.inject({ method: "POST", url: `/boards/${source!.id}/lists/${workspaceLists[1]!.id}/cards`, headers: auth, payload: { title: "Moves into scope" } });
  assert.equal(outOfScope.statusCode, 201);
  const outOfScopeCard = outOfScope.json<{ id: string }>();
  await processBoardMirrors();
  assert.equal((await db.select().from(externalLinks).where(and(eq(externalLinks.provider, `mirror:${mirror.id}`), eq(externalLinks.externalId, outOfScopeCard.id)))).length, 0);
  const movedIntoScope = await app.inject({ method: "POST", url: `/cards/${outOfScopeCard.id}/move`, headers: auth, payload: { listId: sourceList.id, beforeItem: null } });
  assert.equal(movedIntoScope.statusCode, 200, movedIntoScope.body);
  await processBoardMirrors();
  assert.equal((await db.select().from(externalLinks).where(and(eq(externalLinks.provider, `mirror:${mirror.id}`), eq(externalLinks.externalId, outOfScopeCard.id)))).length, 1, "moving into a synced list must link the card");

  const created = await app.inject({ method: "POST", url: `/boards/${source!.id}/lists/${sourceList.id}/cards`, headers: auth, payload: { title: "Mirrored card" } });
  assert.equal(created.statusCode, 201, created.body);
  const sourceCard = created.json<{ id: string }>();
  const initialSourceDueUpdate = await app.inject({ method: "PATCH", url: `/cards/${sourceCard.id}`, headers: auth, payload: { dueDateLocalDate: "2026-08-01", dueDateSlot: "morning" } });
  assert.equal(initialSourceDueUpdate.statusCode, 200, initialSourceDueUpdate.body);
  const initialChecklistResponse = await app.inject({ method: "POST", url: `/cards/${sourceCard.id}/checklists`, headers: auth, payload: { title: "Initial planning" } });
  assert.equal(initialChecklistResponse.statusCode, 201, initialChecklistResponse.body);
  const initialChecklist = initialChecklistResponse.json<{ id: string }>();
  const initialParentResponse = await app.inject({ method: "POST", url: `/cards/${sourceCard.id}/checklists/${initialChecklist.id}/items`, headers: auth, payload: { text: "Initial parent" } });
  assert.equal(initialParentResponse.statusCode, 201, initialParentResponse.body);
  const initialParent = initialParentResponse.json<{ id: string }>();
  const initialParentDetail = await app.inject({ method: "PATCH", url: `/cards/${sourceCard.id}/checklists/${initialChecklist.id}/items/${initialParent.id}`, headers: auth, payload: { description: "Copied parent detail", completed: true, assigneeId: user.id, dueDateLocalDate: "2026-08-02", dueDateSlot: "afternoon" } });
  assert.equal(initialParentDetail.statusCode, 200, initialParentDetail.body);
  const initialNestedResponse = await app.inject({ method: "POST", url: `/cards/${sourceCard.id}/checklists`, headers: auth, payload: { title: "Initial detail steps", parentItemId: initialParent.id } });
  assert.equal(initialNestedResponse.statusCode, 201, initialNestedResponse.body);
  const initialNested = initialNestedResponse.json<{ id: string }>();
  const initialNestedItemResponse = await app.inject({ method: "POST", url: `/cards/${sourceCard.id}/checklists/${initialNested.id}/items`, headers: auth, payload: { text: "Initial nested step" } });
  assert.equal(initialNestedItemResponse.statusCode, 201, initialNestedItemResponse.body);
  const initialCoverForm = new FormData();
  initialCoverForm.append("file", new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")], { type: "image/png" }), "source-cover.png");
  const initialCoverUpload = await app.inject({ method: "POST", url: `/cards/${sourceCard.id}/attachments`, headers: auth, payload: initialCoverForm });
  assert.equal(initialCoverUpload.statusCode, 201, initialCoverUpload.body);
  const sourceCoverAttachment = initialCoverUpload.json<{ id: string }>();
  assert.equal((await db.select().from(cards).where(eq(cards.id, sourceCard.id)))[0]?.coverAttachmentId, sourceCoverAttachment.id);
  await db.insert(cardAssignees).values({ cardId: sourceCard.id, userId: user.id });
  await processBoardMirrors();
  const [link] = await db.select().from(externalLinks).where(and(eq(externalLinks.provider, `mirror:${mirror.id}`), eq(externalLinks.externalType, "card"), eq(externalLinks.externalId, sourceCard.id)));
  assert.ok(link);
  const linkedEvents = (await db.select().from(eventOutbox).where(eq(eventOutbox.eventType, "cardMirror:linked"))).filter((event) => {
    const payload = event.payload as { mirrorId?: string; sourceCardId?: string };
    return payload.mirrorId === mirror.id && payload.sourceCardId === sourceCard.id;
  });
  assert.deepEqual(new Set(linkedEvents.map((event) => event.scopeId)), new Set([source!.id, target!.id]), "both open card contexts receive the relationship link");
  const [targetCard] = await db.select().from(cards).where(eq(cards.id, link!.entityId));
  assert.equal(targetCard?.title, "Mirrored card");
  assert.equal(targetCard?.boardId, target!.id);
  assert.equal(targetCard?.dueDateLocalDate, "2026-08-01", "due date is copied in the initial snapshot");
  assert.equal(targetCard?.dueDateSlot, "morning");
  assert.ok(targetCard?.coverAttachmentId, "source cover is applied in the initial snapshot");
  const initialTargetChecklists = await db.select().from(cardChecklists).where(eq(cardChecklists.cardId, targetCard!.id));
  const initialTargetChecklist = initialTargetChecklists.find((checklist) => checklist.title === "Initial planning");
  assert.ok(initialTargetChecklist);
  const [initialTargetParent] = await db.select().from(cardChecklistItems).where(eq(cardChecklistItems.checklistId, initialTargetChecklist.id));
  assert.equal(initialTargetParent?.description, "Copied parent detail", "initial copy includes checklist item detail");
  assert.equal(initialTargetParent?.completedAt, null, "initial mirror checklist items always start unchecked");
  assert.equal(initialTargetParent?.assigneeId, user.id, "eligible initial checklist assignees are copied independently");
  assert.equal(initialTargetParent?.dueDateLocalDate, "2026-08-02", "initial checklist planning dates are copied once");
  const initialTargetNested = initialTargetChecklists.find((checklist) => checklist.title === "Initial detail steps");
  assert.equal(initialTargetNested?.parentItemId, initialTargetParent?.id, "initial copy preserves sub-checklist hierarchy");
  assert.equal((await db.select().from(cardChecklistItems).where(eq(cardChecklistItems.checklistId, initialTargetNested!.id)))[0]?.text, "Initial nested step");
  const targetCoverCandidate = (await db.select().from(cardAttachments).where(eq(cardAttachments.cardId, targetCard!.id))).find((attachment) => attachment.fileName === "source-cover.png");
  assert.ok(targetCoverCandidate, "the underlying attachment still syncs normally");
  assert.equal(targetCard?.coverAttachmentId, targetCoverCandidate.id);
  assert.deepEqual(
    (await db.select({ userId: cardAssignees.userId }).from(cardAssignees).where(eq(cardAssignees.cardId, targetCard!.id))).map((row) => row.userId),
    [user.id],
  );
  const initialTargetComments = await db.select().from(comments).where(eq(comments.cardId, targetCard!.id));
  assert.equal(initialTargetComments.length, 1, "a newly synced card gets one provenance comment");
  const [sourceLinkComment] = initialTargetComments;
  const provenanceComment = `This card was synced from board Source. Original card URL: [View original card](/b/${source!.id}/c/${sourceCard.id})`;
  assert.equal(sourceLinkComment?.body, provenanceComment);
  assert.equal(sourceLinkComment?.authorKind, "system");

  const targetDueUpdate = await app.inject({ method: "PATCH", url: `/cards/${targetCard!.id}`, headers: auth, payload: { dueDateLocalDate: "2026-09-10", dueDateSlot: "afternoon" } });
  assert.equal(targetDueUpdate.statusCode, 200, targetDueUpdate.body);
  const sourceDueUpdate = await app.inject({ method: "PATCH", url: `/cards/${sourceCard.id}`, headers: auth, payload: { dueDateLocalDate: "2026-10-15", dueDateSlot: "endOfWorkDay" } });
  assert.equal(sourceDueUpdate.statusCode, 200, sourceDueUpdate.body);
  await processBoardMirrors();
  const [targetAfterSourceDueUpdate] = await db.select().from(cards).where(eq(cards.id, targetCard!.id));
  assert.equal(targetAfterSourceDueUpdate?.dueDateLocalDate, "2026-09-10", "later source due dates do not overwrite the destination");
  assert.equal(targetAfterSourceDueUpdate?.dueDateSlot, "afternoon");

  const targetCoverUpdate = await app.inject({ method: "PATCH", url: `/cards/${targetCard!.id}/cover`, headers: auth, payload: { attachmentId: targetCoverCandidate.id } });
  assert.equal(targetCoverUpdate.statusCode, 200, targetCoverUpdate.body);
  const sourceCoverRemoval = await app.inject({ method: "PATCH", url: `/cards/${sourceCard.id}/cover`, headers: auth, payload: { attachmentId: null } });
  assert.equal(sourceCoverRemoval.statusCode, 200, sourceCoverRemoval.body);
  await processBoardMirrors();
  assert.equal((await db.select().from(cards).where(eq(cards.id, targetCard!.id)))[0]?.coverAttachmentId, targetCoverCandidate.id, "later source cover changes do not overwrite the destination cover");

  await db.insert(comments).values({ cardId: targetCard!.id, authorId: user.id, body: "Target-only comment" });
  await db.insert(cardChecklists).values({ cardId: targetCard!.id, title: "Target-only checklist", position: "9000.0000000000" });
  const sourceComment = await app.inject({ method: "POST", url: `/cards/${sourceCard.id}/comments`, headers: auth, payload: { body: "Source comment" } });
  assert.equal(sourceComment.statusCode, 201, sourceComment.body);
  const sourceChecklist = await app.inject({ method: "POST", url: `/cards/${sourceCard.id}/checklists`, headers: auth, payload: { title: "Source checklist" } });
  assert.equal(sourceChecklist.statusCode, 201, sourceChecklist.body);
  const sourceChecklistRow = sourceChecklist.json<{ id: string }>();
  const sourceItemResponse = await app.inject({ method: "POST", url: `/cards/${sourceCard.id}/checklists/${sourceChecklistRow.id}/items`, headers: auth, payload: { text: "Independent workflow item" } });
  assert.equal(sourceItemResponse.statusCode, 201, sourceItemResponse.body);
  const sourceItem = sourceItemResponse.json<{ id: string }>();
  const removableSourceItemResponse = await app.inject({ method: "POST", url: `/cards/${sourceCard.id}/checklists/${sourceChecklistRow.id}/items`, headers: auth, payload: { text: "Remove after first sync" } });
  assert.equal(removableSourceItemResponse.statusCode, 201, removableSourceItemResponse.body);
  const removableSourceItem = removableSourceItemResponse.json<{ id: string }>();
  const initialSourceItemState = await app.inject({
    method: "PATCH",
    url: `/cards/${sourceCard.id}/checklists/${sourceChecklistRow.id}/items/${sourceItem.id}`,
    headers: auth,
    payload: { description: "Source-owned item detail", completed: true, assigneeId: user.id, dueDateLocalDate: "2026-11-01", dueDateSlot: "morning" },
  });
  assert.equal(initialSourceItemState.statusCode, 200, initialSourceItemState.body);
  const sourceNestedChecklistResponse = await app.inject({ method: "POST", url: `/cards/${sourceCard.id}/checklists`, headers: auth, payload: { title: "Source detail steps", parentItemId: sourceItem.id } });
  assert.equal(sourceNestedChecklistResponse.statusCode, 201, sourceNestedChecklistResponse.body);
  const sourceNestedChecklist = sourceNestedChecklistResponse.json<{ id: string }>();
  const sourceNestedItemResponse = await app.inject({ method: "POST", url: `/cards/${sourceCard.id}/checklists/${sourceNestedChecklist.id}/items`, headers: auth, payload: { text: "First detail step" } });
  assert.equal(sourceNestedItemResponse.statusCode, 201, sourceNestedItemResponse.body);
  const sourceNestedItem = sourceNestedItemResponse.json<{ id: string }>();
  // Checklist routes publish realtime after committing and intentionally do not await that promise;
  // wait for the durable dirty signal before directly invoking the worker in this focused test.
  await waitForOutboxEvent(source!.id, "card:checklist:created");
  await processBoardMirrors();
  const dirtyAfterNested = await db.select().from(boardMirrorDirtyCards).where(eq(boardMirrorDirtyCards.mirrorId, mirror.id));
  assert.equal(dirtyAfterNested.length, 0, dirtyAfterNested.map((row) => row.lastError).join("; "));
  const targetComments = await db.select().from(comments).where(eq(comments.cardId, targetCard!.id));
  assert.deepEqual(targetComments.map((comment) => comment.body).sort(), [provenanceComment, "Source comment", "Target-only comment"].sort());
  const mirroredComment = targetComments.find((comment) => comment.body === "Source comment");
  assert.equal(mirroredComment?.authorKind, "system");
  assert.equal(mirroredComment?.apiKeyName, "Owner");
  const targetChecklists = await db.select().from(cardChecklists).where(eq(cardChecklists.cardId, targetCard!.id));
  assert.deepEqual(targetChecklists.filter((checklist) => checklist.parentItemId === null).map((checklist) => checklist.title).sort(), ["Initial planning", "Source checklist", "Target-only checklist"]);
  const targetSourceChecklist = targetChecklists.find((checklist) => checklist.title === "Source checklist");
  assert.ok(targetSourceChecklist);
  const initialTargetItems = await db.select().from(cardChecklistItems).where(eq(cardChecklistItems.checklistId, targetSourceChecklist.id));
  const initialTargetItem = initialTargetItems.find((item) => item.text === "Independent workflow item");
  assert.equal(initialTargetItem?.description, "Source-owned item detail");
  assert.equal(initialTargetItem?.completedAt, null, "items introduced after the card copy start with destination-owned completion state");
  assert.equal(initialTargetItem?.assigneeId, null, "items introduced after the card copy start unassigned");
  assert.equal(initialTargetItem?.dueDateLocalDate, null, "items introduced after the card copy start without a due date");
  const firstSyncedTargetNested = targetChecklists.find((checklist) => checklist.title === "Source detail steps");
  assert.equal(firstSyncedTargetNested?.parentItemId, initialTargetItem?.id, "new sub-checklists remain attached to their mirrored parent item");
  assert.equal((await db.select().from(cardChecklistItems).where(eq(cardChecklistItems.checklistId, firstSyncedTargetNested!.id)))[0]?.text, "First detail step");

  const targetItemDivergence = await app.inject({
    method: "PATCH",
    url: `/cards/${targetCard!.id}/checklists/${targetSourceChecklist.id}/items/${initialTargetItem!.id}`,
    headers: auth,
    payload: { completed: true, assigneeId: user.id, dueDateLocalDate: "2026-12-01", dueDateSlot: "afternoon" },
  });
  assert.equal(targetItemDivergence.statusCode, 200, targetItemDivergence.body);
  const sourceChecklistEventCount = (await db.select({ id: eventOutbox.id }).from(eventOutbox).where(and(eq(eventOutbox.boardId, source!.id), eq(eventOutbox.eventType, "card:checklistItem:updated")))).length;
  const laterSourceItemState = await app.inject({
    method: "PATCH",
    url: `/cards/${sourceCard.id}/checklists/${sourceChecklistRow.id}/items/${sourceItem.id}`,
    headers: auth,
    payload: { text: "Renamed workflow item", description: "Updated source detail", completed: false, assigneeId: null, dueDateLocalDate: "2027-01-15", dueDateSlot: "endOfWorkDay" },
  });
  assert.equal(laterSourceItemState.statusCode, 200, laterSourceItemState.body);
  const renamedNestedChecklist = await app.inject({ method: "PATCH", url: `/cards/${sourceCard.id}/checklists/${sourceNestedChecklist.id}`, headers: auth, payload: { title: "Renamed detail steps" } });
  assert.equal(renamedNestedChecklist.statusCode, 200, renamedNestedChecklist.body);
  const addedNestedItem = await app.inject({ method: "POST", url: `/cards/${sourceCard.id}/checklists/${sourceNestedChecklist.id}/items`, headers: auth, payload: { text: "Replacement detail step" } });
  assert.equal(addedNestedItem.statusCode, 201, addedNestedItem.body);
  const deletedNestedItem = await app.inject({ method: "DELETE", url: `/cards/${sourceCard.id}/checklists/${sourceNestedChecklist.id}/items/${sourceNestedItem.id}`, headers: auth });
  assert.equal(deletedNestedItem.statusCode, 204, deletedNestedItem.body);
  const deletedTopLevelItem = await app.inject({ method: "DELETE", url: `/cards/${sourceCard.id}/checklists/${sourceChecklistRow.id}/items/${removableSourceItem.id}`, headers: auth });
  assert.equal(deletedTopLevelItem.statusCode, 204, deletedTopLevelItem.body);
  const laterChecklistResponse = await app.inject({ method: "POST", url: `/cards/${sourceCard.id}/checklists`, headers: auth, payload: { title: "Later source checklist" } });
  assert.equal(laterChecklistResponse.statusCode, 201, laterChecklistResponse.body);
  await waitForNewOutboxEvent(source!.id, "card:checklistItem:updated", sourceChecklistEventCount);
  await processBoardMirrors();
  const [rebuiltTargetChecklist] = await db.select().from(cardChecklists).where(and(eq(cardChecklists.cardId, targetCard!.id), eq(cardChecklists.title, "Source checklist")));
  const [preservedTargetItem] = await db.select().from(cardChecklistItems).where(eq(cardChecklistItems.checklistId, rebuiltTargetChecklist!.id));
  assert.equal(rebuiltTargetChecklist?.id, targetSourceChecklist.id, "checklist convergence preserves stable destination ids");
  assert.equal(preservedTargetItem?.id, initialTargetItem?.id, "a source item edit updates in place instead of rebuilding its tree");
  assert.equal(preservedTargetItem?.text, "Renamed workflow item", "checklist item text remains source-managed");
  assert.equal(preservedTargetItem?.description, "Updated source detail", "checklist item detail remains source-managed");
  assert.ok(preservedTargetItem?.completedAt, "later source completion does not overwrite destination state");
  assert.equal(preservedTargetItem?.assigneeId, user.id, "later source assignment does not overwrite destination state");
  assert.equal(preservedTargetItem?.dueDateLocalDate, "2026-12-01", "later source due date does not overwrite destination state");
  assert.equal(preservedTargetItem?.dueDateSlot, "afternoon");
  const convergedChecklistRows = await db.select().from(cardChecklists).where(eq(cardChecklists.cardId, targetCard!.id));
  const convergedNested = convergedChecklistRows.find((checklist) => checklist.title === "Renamed detail steps");
  assert.equal(convergedNested?.parentItemId, preservedTargetItem?.id);
  assert.deepEqual((await db.select().from(cardChecklistItems).where(eq(cardChecklistItems.checklistId, convergedNested!.id))).map((item) => item.text), ["Replacement detail step"]);
  assert.ok(convergedChecklistRows.some((checklist) => checklist.title === "Later source checklist" && checklist.parentItemId === null), "new source checklists continue to sync");
  const allConvergedItemTexts = (await Promise.all(convergedChecklistRows.map((checklist) => db.select({ text: cardChecklistItems.text }).from(cardChecklistItems).where(eq(cardChecklistItems.checklistId, checklist.id))))).flat().map((item) => item.text);
  assert.equal(allConvergedItemTexts.includes("Remove after first sync"), false, "removed source checklist items are removed from the destination");
  assert.equal(allConvergedItemTexts.includes("First detail step"), false, "removed sub-checklist items are removed from the destination");

  const targetMovedOutside = await app.inject({ method: "POST", url: `/cards/${targetCard!.id}/move`, headers: auth, payload: { listId: workspaceLists[1]!.id, beforeItem: null } });
  assert.equal(targetMovedOutside.statusCode, 200, targetMovedOutside.body);
  const [trackingField] = await db.insert(customFields).values({ workspaceId: workspace.id, name: "Mirror status", type: "text", position: "9000.0000000000" }).returning();
  const fieldUpdate = await app.inject({ method: "PUT", url: `/cards/${sourceCard.id}/custom-fields/${trackingField!.id}`, headers: auth, payload: { valueText: "Ready" } });
  assert.equal(fieldUpdate.statusCode, 200, fieldUpdate.body);
  const descriptionOutside = await app.inject({ method: "PATCH", url: `/cards/${sourceCard.id}`, headers: auth, payload: { description: "Still synced outside mapped lists" } });
  assert.equal(descriptionOutside.statusCode, 200, descriptionOutside.body);
  const commentOutside = await app.inject({ method: "POST", url: `/cards/${sourceCard.id}/comments`, headers: auth, payload: { body: "Outside-list comment" } });
  assert.equal(commentOutside.statusCode, 201, commentOutside.body);
  const attachmentCreatedCount = (await db.select({ id: eventOutbox.id }).from(eventOutbox).where(and(eq(eventOutbox.boardId, source!.id), eq(eventOutbox.eventType, "card:attachment:created")))).length;
  const attachmentForm = new FormData();
  attachmentForm.append("file", new Blob(["outside-list attachment"], { type: "text/plain" }), "outside-list.txt");
  const attachmentOutside = await app.inject({ method: "POST", url: `/cards/${sourceCard.id}/attachments`, headers: auth, payload: attachmentForm });
  assert.equal(attachmentOutside.statusCode, 201, attachmentOutside.body);
  await waitForNewOutboxEvent(source!.id, "card:attachment:created", attachmentCreatedCount);
  await processBoardMirrors();
  const [syncedOutside] = await db.select().from(cards).where(eq(cards.id, targetCard!.id));
  assert.equal(syncedOutside?.listId, workspaceLists[1]!.id, "content sync must preserve a destination move outside mapped lists");
  assert.equal(syncedOutside?.description, "Still synced outside mapped lists");
  assert.ok((await db.select().from(comments).where(eq(comments.cardId, targetCard!.id))).some((comment) => comment.body === "Outside-list comment"));
  const mirroredOutsideAttachment = (await db.select().from(cardAttachments).where(eq(cardAttachments.cardId, targetCard!.id))).find((attachment) => attachment.fileName === "outside-list.txt");
  assert.ok(mirroredOutsideAttachment);
  assert.equal((await db.select().from(cardCustomFieldValues).where(and(eq(cardCustomFieldValues.cardId, targetCard!.id), eq(cardCustomFieldValues.fieldId, trackingField!.id))))[0]?.valueText, "Ready");

  const mirroredActivities = await db.select().from(activityEvents).where(and(eq(activityEvents.boardId, target!.id), eq(activityEvents.entityId, targetCard!.id)));
  const mirroredCreatedActivity = mirroredActivities.find((activity) => activity.action === "created");
  assert.ok(mirroredCreatedActivity, "mirror creation has a destination-card activity");
  assert.equal((mirroredCreatedActivity.payload as Record<string, unknown>).copiedActorName, "Owner");
  assert.equal((mirroredCreatedActivity.payload as Record<string, unknown>).mirrorId, mirror.id);
  assert.equal((mirroredCreatedActivity.payload as Record<string, unknown>).duplicatedFromId, undefined, "the activity reads as card creation; provenance lives in the system comment");
  const mirroredDescriptionActivity = mirroredActivities.find((activity) => activity.action === "updated" && (activity.payload as Record<string, unknown>).description === "Still synced outside mapped lists");
  assert.ok(mirroredDescriptionActivity, "description sync copies the original rich activity");
  assert.equal(mirroredDescriptionActivity.actorKind, "system");
  assert.equal((mirroredDescriptionActivity.payload as Record<string, unknown>).fromValue, null);
  assert.equal((mirroredDescriptionActivity.payload as Record<string, unknown>).toValue, "Still synced outside mapped lists");
  assert.equal((mirroredDescriptionActivity.payload as Record<string, unknown>).copiedActorName, "Owner");
  assert.equal((mirroredDescriptionActivity.payload as Record<string, unknown>).mirrorId, mirror.id);
  const mirroredFieldActivity = mirroredActivities.find((activity) => activity.action === "customFieldValue:set" && (activity.payload as Record<string, unknown>).fieldName === "Mirror status");
  assert.equal((mirroredFieldActivity?.payload as Record<string, unknown> | undefined)?.toValue, "Ready");
  const mirroredAttachmentActivity = mirroredActivities.find((activity) => activity.action === "attachment_added" && (activity.payload as Record<string, unknown>).fileName === "outside-list.txt");
  assert.equal((mirroredAttachmentActivity?.payload as Record<string, unknown> | undefined)?.attachmentId, mirroredOutsideAttachment.id, "attachment activity points at the copied preview asset");
  assert.equal((mirroredAttachmentActivity?.payload as Record<string, unknown> | undefined)?.copiedActorName, "Owner", "attachment activity names its original uploader");
  assert.equal(mirroredActivities.some((activity) => {
    const payload = activity.payload as Record<string, unknown>;
    return payload.mirrorId === mirror.id && payload.dueDateLocalDate === "2026-10-15";
  }), false, "later source due-date activity is not copied to the destination audit trail");
  assert.equal(mirroredActivities.some((activity) => activity.payload && (activity.payload as Record<string, unknown>).mirrorId === mirror.id && (activity.action === "cover_set" || activity.action === "cover_removed")), false, "source cover activity is not copied to the destination audit trail");
  assert.equal(mirroredActivities.some((activity) => {
    const mirrorActivity = (activity.payload as Record<string, unknown>).mirrorId === mirror.id;
    return mirrorActivity && ["checklist:completed", "checklistItem:completion", "checklistItem:assignee:set", "checklistItem:dueDate:set"].includes(activity.action);
  }), false, "source checklist workflow-state activity is not copied to the destination audit trail");
  assert.equal(mirroredActivities.some((activity) => activity.coalesceKey === "card:mirrorSync"), false, "generic mirror-sync text is no longer recorded");

  const commentCreatedCount = (await db.select({ id: eventOutbox.id }).from(eventOutbox).where(and(eq(eventOutbox.boardId, source!.id), eq(eventOutbox.eventType, "comment:created")))).length;
  const transientCommentResponse = await app.inject({ method: "POST", url: `/cards/${sourceCard.id}/comments`, headers: auth, payload: { body: "Transient mirrored comment" } });
  assert.equal(transientCommentResponse.statusCode, 201, transientCommentResponse.body);
  const transientSourceComment = transientCommentResponse.json<{ id: string }>();
  await waitForNewOutboxEvent(source!.id, "comment:created", commentCreatedCount);
  await processBoardMirrors();
  const [transientTargetComment] = await db.select().from(comments).where(and(eq(comments.cardId, targetCard!.id), eq(comments.body, "Transient mirrored comment")));
  assert.ok(transientTargetComment, "new comments appear as full feed cards");
  const targetFeedResponse = await app.inject({ method: "GET", url: `/cards/${targetCard!.id}/feed`, headers: auth });
  assert.equal(targetFeedResponse.statusCode, 200, targetFeedResponse.body);
  const targetFeedComment = targetFeedResponse.json<{ items: Array<{ type: string; data: { id: string; authorName?: string; apiKeyName?: string | null; mirrorId?: string | null } }> }>()
    .items.find((item) => item.type === "comment" && item.data.id === transientTargetComment.id)?.data;
  assert.equal(targetFeedComment?.authorName, "Kanera");
  assert.equal(targetFeedComment?.apiKeyName, "Owner");
  assert.equal(targetFeedComment?.mirrorId, mirror.id, "mirrored comments carry provenance for the link marker and attribution line");
  const targetFeedProvenanceComment = targetFeedResponse.json<{ items: Array<{ type: string; data: { id: string; mirrorId?: string | null } }> }>()
    .items.find((item) => item.type === "comment" && item.data.id === sourceLinkComment!.id)?.data;
  assert.equal(targetFeedProvenanceComment?.mirrorId, mirror.id, "the initial Board mirror comment also receives the link marker");
  const commentUpdatedCount = (await db.select({ id: eventOutbox.id }).from(eventOutbox).where(and(eq(eventOutbox.boardId, source!.id), eq(eventOutbox.eventType, "comment:updated")))).length;
  const transientEdit = await app.inject({ method: "PATCH", url: `/comments/${transientSourceComment.id}`, headers: auth, payload: { body: "Edited mirrored comment" } });
  assert.equal(transientEdit.statusCode, 200, transientEdit.body);
  await waitForNewOutboxEvent(source!.id, "comment:updated", commentUpdatedCount);
  await processBoardMirrors();
  assert.equal((await db.select().from(comments).where(eq(comments.id, transientTargetComment.id)))[0]?.body, "Edited mirrored comment");
  const commentDeletedCount = (await db.select({ id: eventOutbox.id }).from(eventOutbox).where(and(eq(eventOutbox.boardId, source!.id), eq(eventOutbox.eventType, "comment:deleted")))).length;
  const transientDelete = await app.inject({ method: "DELETE", url: `/comments/${transientSourceComment.id}`, headers: auth });
  assert.equal(transientDelete.statusCode, 204, transientDelete.body);
  await waitForNewOutboxEvent(source!.id, "comment:deleted", commentDeletedCount);
  await processBoardMirrors();
  assert.equal((await db.select().from(comments).where(eq(comments.id, transientTargetComment.id))).length, 0, "deleted source comments leave the mirrored feed");
  const targetFeedEvents = await db.select().from(eventOutbox).where(eq(eventOutbox.boardId, target!.id));
  assert.ok(targetFeedEvents.some((event) => event.eventType === "card:feedItem:created" && (event.payload as { item?: { type?: string; data?: { id?: string } } }).item?.data?.id === transientTargetComment.id));
  assert.ok(targetFeedEvents.some((event) => event.eventType === "card:feedItem:updated" && (event.payload as { item?: { type?: string; data?: { id?: string } } }).item?.data?.id === transientTargetComment.id));
  assert.ok(targetFeedEvents.some((event) => event.eventType === "card:feedItem:deleted" && (event.payload as { itemId?: string }).itemId === transientTargetComment.id));

  const movedOut = await app.inject({ method: "POST", url: `/cards/${sourceCard.id}/move`, headers: auth, payload: { listId: workspaceLists[1]!.id, beforeItem: null } });
  assert.equal(movedOut.statusCode, 200, movedOut.body);
  await processBoardMirrors();
  const [stayed] = await db.select().from(cards).where(eq(cards.id, targetCard!.id));
  assert.equal(stayed?.listId, workspaceLists[1]!.id, "source list scope changes must preserve the destination card's chosen list");

  const updated = await app.inject({ method: "PATCH", url: `/cards/${sourceCard.id}`, headers: auth, payload: { title: "Source wins" } });
  assert.equal(updated.statusCode, 200, updated.body);
  await processBoardMirrors();
  const [converged] = await db.select().from(cards).where(eq(cards.id, targetCard!.id));
  assert.equal(converged?.title, "Source wins");
  assert.equal(converged?.listId, workspaceLists[1]!.id, "linked cards remain synced without being pulled back into mapped lists");

  const terminalCreate = await app.inject({ method: "POST", url: `/boards/${source!.id}/lists/${sourceList.id}/cards`, headers: auth, payload: { title: "Destination-owned lifecycle" } });
  assert.equal(terminalCreate.statusCode, 201, terminalCreate.body);
  const terminalSource = terminalCreate.json<{ id: string }>();
  await processBoardMirrors();
  const [terminalLink] = await db.select().from(externalLinks).where(and(eq(externalLinks.provider, `mirror:${mirror.id}`), eq(externalLinks.externalType, "card"), eq(externalLinks.externalId, terminalSource.id)));
  assert.ok(terminalLink);
  const terminalArchive = await app.inject({ method: "PATCH", url: `/cards/${terminalLink.entityId}/archive`, headers: auth, payload: { archived: true } });
  assert.equal(terminalArchive.statusCode, 200, terminalArchive.body);
  const terminalSourceUpdate = await app.inject({ method: "PATCH", url: `/cards/${terminalSource.id}`, headers: auth, payload: { title: "Must not sync after target archive" } });
  assert.equal(terminalSourceUpdate.statusCode, 200, terminalSourceUpdate.body);
  await processBoardMirrors();
  const [archivedTarget] = await db.select().from(cards).where(eq(cards.id, terminalLink.entityId));
  assert.ok(archivedTarget?.archivedAt, "target archive remains a local lifecycle decision");
  assert.equal(archivedTarget?.title, "Destination-owned lifecycle", "source changes stop after the target is archived");

  // Archived-card cleanup eventually hard-deletes the destination row. The retained card link is a
  // tombstone proving the sync already happened, so another source change still cannot recreate it.
  await db.delete(cards).where(eq(cards.id, terminalLink.entityId));
  const terminalSourceUpdateAfterPurge = await app.inject({ method: "PATCH", url: `/cards/${terminalSource.id}`, headers: auth, payload: { title: "Must not recreate after target purge" } });
  assert.equal(terminalSourceUpdateAfterPurge.statusCode, 200, terminalSourceUpdateAfterPurge.body);
  await processBoardMirrors();
  assert.equal((await db.select().from(cards).where(eq(cards.id, terminalLink.entityId))).length, 0);
  const [retainedTerminalLink] = await db.select().from(externalLinks).where(and(eq(externalLinks.provider, `mirror:${mirror.id}`), eq(externalLinks.externalType, "card"), eq(externalLinks.externalId, terminalSource.id)));
  assert.equal(retainedTerminalLink?.entityId, terminalLink.entityId, "purged target keeps its no-recreate tombstone");

  const updatedEventCount = (await db.select({ id: eventOutbox.id }).from(eventOutbox).where(and(eq(eventOutbox.boardId, source!.id), eq(eventOutbox.eventType, "card:updated")))).length;
  const archived = await app.inject({ method: "PATCH", url: `/cards/${sourceCard.id}/archive`, headers: auth, payload: { archived: true } });
  assert.equal(archived.statusCode, 200, archived.body);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const count = (await db.select({ id: eventOutbox.id }).from(eventOutbox).where(and(eq(eventOutbox.boardId, source!.id), eq(eventOutbox.eventType, "card:updated")))).length;
    if (count > updatedEventCount) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await processBoardMirrors();
  // Source archive now propagates onto the mirror-archived target (the mirror owns that state via a
  // marker link), records a first-class archive activity, and removes the card from target boards.
  assert.ok((await db.select().from(cards).where(eq(cards.id, targetCard!.id)))[0]?.archivedAt, "source archive propagates to the mirror-archived target");
  const archiveComments = (await db.select().from(comments).where(eq(comments.cardId, targetCard!.id))).filter((comment) => comment.body === "The original card was archived.");
  assert.equal(archiveComments.length, 1, "source archive leaves one system comment on the target");
  assert.equal(archiveComments[0]?.authorKind, "system");
  const [archiveMarker] = await db.select().from(externalLinks).where(and(eq(externalLinks.provider, `mirror:${mirror.id}`), eq(externalLinks.externalType, "cardTargetMirrorArchive"), eq(externalLinks.externalId, sourceCard.id)));
  assert.equal(archiveMarker?.entityId, targetCard!.id, "the mirror records that it owns the target's archived state");
  const mirrorArchiveActivities = () => db.select().from(activityEvents).where(and(eq(activityEvents.boardId, target!.id), eq(activityEvents.entityId, targetCard!.id)))
    .then((rows) => rows.filter((activity) => activity.action === "archived" && (activity.payload as Record<string, unknown>).mirrorId === mirror.id));
  assert.equal((await mirrorArchiveActivities()).length, 1, "the target gets one first-class archive activity");
  const targetArchiveUpdateEvents = (await db.select().from(eventOutbox).where(and(eq(eventOutbox.boardId, target!.id), eq(eventOutbox.eventType, "card:updated")))).filter((event) => {
    const card = (event.payload as { card?: { id?: string; archivedAt?: string | null } }).card;
    return card?.id === targetCard!.id && card?.archivedAt != null;
  });
  assert.ok(targetArchiveUpdateEvents.length >= 1, "target board receives a card:updated carrying archivedAt so clients remove the card");

  const [archivedSourceCard] = await db.select().from(cards).where(eq(cards.id, sourceCard.id));
  await db.insert(eventOutbox).values({
    scope: "board",
    scopeId: source!.id,
    workspaceId: workspace.id,
    boardId: source!.id,
    eventType: "card:updated",
    payload: {
      boardId: source!.id,
      card: {
        id: archivedSourceCard!.id,
        listId: archivedSourceCard!.listId,
        boardId: archivedSourceCard!.boardId,
        title: archivedSourceCard!.title,
        position: archivedSourceCard!.position,
        createdById: archivedSourceCard!.createdById,
        createdAt: archivedSourceCard!.createdAt,
        updatedAt: archivedSourceCard!.updatedAt,
      },
    },
  });
  await processBoardMirrors();
  assert.ok((await db.select().from(cards).where(eq(cards.id, targetCard!.id)))[0]?.archivedAt, "redraining an archived source keeps the target archived");
  assert.equal((await db.select().from(comments).where(eq(comments.cardId, targetCard!.id))).filter((comment) => comment.body === "The original card was archived.").length, 1, "reprocessing an archived source is idempotent");
  assert.equal((await db.select().from(externalLinks).where(and(eq(externalLinks.provider, `mirror:${mirror.id}`), eq(externalLinks.externalType, "cardTargetMirrorArchive"), eq(externalLinks.externalId, sourceCard.id)))).length, 1, "redrain keeps exactly one archive marker");
  assert.equal((await mirrorArchiveActivities()).length, 1, "redrain does not duplicate the archive activity");

  // Content can accrue on the source relative to a mirror-archived target: a comment authored just
  // before the archive whose sync coalesced behind it and was held back by the terminal guard, plus a
  // title the guard let through core. The archived source is read-only via the API, so seed that held
  // backlog directly to model the state the widening on unarchive must reconcile.
  await db.insert(comments).values({ cardId: sourceCard.id, authorId: user.id, body: "Comment added while archived" });
  await db.update(cards).set({ title: "Edited while archived" }).where(eq(cards.id, sourceCard.id));
  await processBoardMirrors();
  assert.equal((await db.select().from(comments).where(eq(comments.cardId, targetCard!.id))).some((comment) => comment.body === "Comment added while archived"), false, "held source content does not sync onto the hidden mirror-archived target");

  const targetListBeforeUnarchive = (await db.select().from(cards).where(eq(cards.id, targetCard!.id)))[0]!;
  const unarchived = await app.inject({ method: "PATCH", url: `/cards/${sourceCard.id}/archive`, headers: auth, payload: { archived: false } });
  assert.equal(unarchived.statusCode, 200, unarchived.body);
  await processBoardMirrors();
  const [restoredTarget] = await db.select().from(cards).where(eq(cards.id, targetCard!.id));
  assert.equal(restoredTarget?.archivedAt, null, "source unarchive restores the mirror-archived target");
  assert.equal(restoredTarget?.title, "Edited while archived", "edits made while archived catch up on unarchive");
  assert.equal(restoredTarget?.listId, targetListBeforeUnarchive.listId, "unarchive leaves the target in its existing list");
  assert.equal(restoredTarget?.position, targetListBeforeUnarchive.position, "unarchive does not reposition the target");
  assert.ok((await db.select().from(comments).where(eq(comments.cardId, targetCard!.id))).some((comment) => comment.body === "Comment added while archived"), "comments authored during the archived window catch up on unarchive");
  assert.equal((await db.select().from(externalLinks).where(and(eq(externalLinks.provider, `mirror:${mirror.id}`), eq(externalLinks.externalType, "cardTargetMirrorArchive"), eq(externalLinks.externalId, sourceCard.id)))).length, 0, "unarchive clears the archive marker");
  assert.equal((await db.select().from(externalLinks).where(and(eq(externalLinks.provider, `mirror:${mirror.id}`), eq(externalLinks.externalType, "cardSourceArchiveComment"), eq(externalLinks.externalId, sourceCard.id)))).length, 0, "unarchive resets the archive-comment episode");
  assert.equal((await db.select().from(activityEvents).where(and(eq(activityEvents.boardId, target!.id), eq(activityEvents.entityId, targetCard!.id)))).filter((activity) => activity.action === "unarchived" && (activity.payload as Record<string, unknown>).mirrorId === mirror.id).length, 1, "unarchive records a first-class unarchive activity on the target");

  // Re-archiving after an unarchive is a fresh episode: a new archive comment posts and the target
  // archives again under a new marker.
  const rearchived = await app.inject({ method: "PATCH", url: `/cards/${sourceCard.id}/archive`, headers: auth, payload: { archived: true } });
  assert.equal(rearchived.statusCode, 200, rearchived.body);
  await processBoardMirrors();
  assert.ok((await db.select().from(cards).where(eq(cards.id, targetCard!.id)))[0]?.archivedAt, "re-archiving the source re-archives the target");
  assert.equal((await db.select().from(comments).where(eq(comments.cardId, targetCard!.id))).filter((comment) => comment.body === "The original card was archived.").length, 2, "a fresh archive episode posts a new archive comment");
  assert.equal((await db.select().from(externalLinks).where(and(eq(externalLinks.provider, `mirror:${mirror.id}`), eq(externalLinks.externalType, "cardTargetMirrorArchive"), eq(externalLinks.externalId, sourceCard.id)))).length, 1, "re-archive re-establishes exactly one marker");

  await db.insert(eventOutbox).values({ scope: "board", scopeId: source!.id, workspaceId: workspace.id, boardId: source!.id, eventType: "card:deleted", payload: { boardId: source!.id, cardId: sourceCard.id } });
  await db.delete(cards).where(eq(cards.id, sourceCard.id));
  await processBoardMirrors();
  const unlinkedEvents = (await db.select().from(eventOutbox).where(eq(eventOutbox.eventType, "cardMirror:unlinked"))).filter((event) => {
    const payload = event.payload as { mirrorId?: string; sourceCardId?: string };
    return payload.mirrorId === mirror.id && payload.sourceCardId === sourceCard.id;
  });
  assert.deepEqual(new Set(unlinkedEvents.map((event) => event.scopeId)), new Set([source!.id, target!.id]), "source deletion invalidates relationship badges on both boards");
  // Hard-deleting an archived source ends sync but leaves the last synced lifecycle state standing:
  // the target remains archived, and every managed link (including the archive marker) is pruned.
  assert.ok((await db.select().from(cards).where(eq(cards.id, targetCard!.id)))[0]?.archivedAt, "hard source deletion preserves the last synced archived lifecycle state");
  assert.equal((await db.select().from(externalLinks).where(eq(externalLinks.provider, `mirror:${mirror.id}`))).some((row) => row.externalId === sourceCard.id || row.entityId === targetCard!.id), false, "source deletion must prune managed links, including the archive marker");

  await processBoardMirrors();
  assert.equal((await db.select().from(externalLinks).where(and(eq(externalLinks.provider, `mirror:${mirror.id}`), eq(externalLinks.externalType, "card"), eq(externalLinks.externalId, outOfScopeCard.id)))).length, 1, "redrain must stay idempotent");
  const [mirrorRow] = await db.select().from(boardMirrors).where(eq(boardMirrors.id, mirror.id));
  assert.equal(mirrorRow?.lastError, null);
});

void test("initial cross-workspace sync maps destination members, labels, and fields by name", async () => {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Mirror Mapping Org", email: "mirror-mapping-owner@example.com", password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(signup.statusCode, 200, signup.body);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string; clientId: string } }>();
  const auth = { authorization: `Bearer ${accessToken}` };

  const sourceResponse = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: auth,
    payload: {
      name: "Source workspace",
      initialBoard: { name: "Source board" },
      lists: [{ name: "Todo" }, { name: "Done" }],
      labels: [{ name: "Shared label" }, { name: "Source-only label" }],
      customFields: [
        { name: "Shared field", icon: "forms", type: "text" },
        { name: "Source-only field", icon: "forms", type: "text" },
      ],
    },
  });
  assert.equal(sourceResponse.statusCode, 201, sourceResponse.body);
  const sourceWorkspace = sourceResponse.json<{ id: string; initialBoard: { id: string } }>();

  const targetResponse = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: auth,
    payload: {
      kind: "board",
      name: "Standalone destination",
      initialBoard: { name: "Standalone destination" },
      lists: [{ name: "Todo" }, { name: "Done" }],
      labels: [{ name: "Shared label" }],
      customFields: [{ name: "Shared field", icon: "forms", type: "text" }],
    },
  });
  assert.equal(targetResponse.statusCode, 201, targetResponse.body);
  const targetWorkspace = targetResponse.json<{ id: string; initialBoard: { id: string } }>();

  const [sourceLists, targetLists, sourceLabels, targetLabels, sourceFields, targetFields] = await Promise.all([
    db.select().from(lists).where(eq(lists.workspaceId, sourceWorkspace.id)).orderBy(lists.position),
    db.select().from(lists).where(eq(lists.workspaceId, targetWorkspace.id)).orderBy(lists.position),
    db.select().from(cardLabels).where(eq(cardLabels.workspaceId, sourceWorkspace.id)).orderBy(cardLabels.position),
    db.select().from(cardLabels).where(eq(cardLabels.workspaceId, targetWorkspace.id)).orderBy(cardLabels.position),
    db.select().from(customFields).where(eq(customFields.workspaceId, sourceWorkspace.id)).orderBy(customFields.position),
    db.select().from(customFields).where(eq(customFields.workspaceId, targetWorkspace.id)).orderBy(customFields.position),
  ]);
  const sourceTodo = sourceLists.find((row) => row.name === "Todo")!;
  const targetTodo = targetLists.find((row) => row.name === "Todo")!;
  const sourceSharedLabel = sourceLabels.find((row) => row.name === "Shared label")!;
  const sourceOnlyLabel = sourceLabels.find((row) => row.name === "Source-only label")!;
  const targetSharedLabel = targetLabels.find((row) => row.name === "Shared label")!;
  const sourceSharedField = sourceFields.find((row) => row.name === "Shared field")!;
  const sourceOnlyField = sourceFields.find((row) => row.name === "Source-only field")!;
  const targetSharedField = targetFields.find((row) => row.name === "Shared field")!;

  const mirrorResponse = await app.inject({
    method: "POST",
    url: `/boards/${sourceWorkspace.initialBoard.id}/mirrors`,
    headers: auth,
    payload: {
      targetBoardId: targetWorkspace.initialBoard.id,
      lists: [{ sourceListId: sourceTodo.id, targetListId: targetTodo.id }],
    },
  });
  assert.equal(mirrorResponse.statusCode, 201, mirrorResponse.body);
  const mirror = mirrorResponse.json<{ id: string }>();

  const [sourceOnlyUser] = await db.insert(users).values({
    clientId: user.clientId,
    email: "mirror-source-only@example.com",
    passwordHash: "hash",
    displayName: "Source only",
  }).returning();
  await db.insert(boardMembers).values({ boardId: sourceWorkspace.initialBoard.id, userId: sourceOnlyUser!.id, role: "editor" });
  const [sharedWorkspaceUser] = await db.insert(users).values({
    clientId: user.clientId,
    email: "mirror-shared-workspace@example.com",
    passwordHash: "hash",
    displayName: "Shared workspace user",
  }).returning();
  await db.insert(workspaceMembers).values([
    { workspaceId: sourceWorkspace.id, userId: sharedWorkspaceUser!.id, role: "member" },
    { workspaceId: targetWorkspace.id, userId: sharedWorkspaceUser!.id, role: "member" },
  ]);
  const [sourceUserField, targetUserField] = await db.insert(customFields).values([
    { workspaceId: sourceWorkspace.id, name: "Reviewer", type: "user", position: "9000.0000000000" },
    { workspaceId: targetWorkspace.id, name: "Reviewer", type: "user", position: "9000.0000000000" },
  ]).returning();

  const [sourceCard] = await db.insert(cards).values({
    listId: sourceTodo.id,
    boardId: sourceWorkspace.initialBoard.id,
    title: "Mapped initial values",
    description: "Initial mirrored description",
    position: "1000.0000000000",
    createdById: user.id,
  }).returning();
  const [sourceChecklist] = await db.insert(cardChecklists).values({ cardId: sourceCard!.id, title: "Independent assignee", position: "1000.0000000000" }).returning();
  await db.insert(cardChecklistItems).values({ checklistId: sourceChecklist!.id, text: "Review independently", position: "1000.0000000000", assigneeId: sharedWorkspaceUser!.id });
  await db.insert(cardAssignees).values([
    { cardId: sourceCard!.id, userId: user.id },
    { cardId: sourceCard!.id, userId: sourceOnlyUser!.id },
  ]);
  await db.insert(cardLabelAssignments).values([
    { cardId: sourceCard!.id, labelId: sourceSharedLabel.id },
    { cardId: sourceCard!.id, labelId: sourceOnlyLabel.id },
  ]);
  await db.insert(cardCustomFieldValues).values([
    { cardId: sourceCard!.id, fieldId: sourceSharedField.id, valueText: "Copied value" },
    { cardId: sourceCard!.id, fieldId: sourceOnlyField.id, valueText: "Must not leak" },
    { cardId: sourceCard!.id, fieldId: sourceUserField!.id, valueUserIds: [sharedWorkspaceUser!.id] },
  ]);
  // Only the create signal is queued: labels and fields must come from the initial source snapshot,
  // not from later facet events that happen to repair an incomplete first copy.
  await db.insert(eventOutbox).values({
    scope: "board",
    scopeId: sourceWorkspace.initialBoard.id,
    workspaceId: sourceWorkspace.id,
    boardId: sourceWorkspace.initialBoard.id,
    eventType: "card:created",
    payload: {
      boardId: sourceWorkspace.initialBoard.id,
      card: {
        id: sourceCard!.id,
        listId: sourceCard!.listId,
        boardId: sourceCard!.boardId,
        title: sourceCard!.title,
        position: sourceCard!.position,
        createdById: sourceCard!.createdById,
        createdAt: sourceCard!.createdAt,
        updatedAt: sourceCard!.updatedAt,
      },
    },
  });

  await processBoardMirrors();
  const [link] = await db.select().from(externalLinks).where(and(
    eq(externalLinks.provider, `mirror:${mirror.id}`),
    eq(externalLinks.externalType, "card"),
    eq(externalLinks.externalId, sourceCard!.id),
  ));
  assert.ok(link);
  const targetCardId = link.entityId;

  assert.deepEqual(
    (await db.select({ userId: cardAssignees.userId }).from(cardAssignees).where(eq(cardAssignees.cardId, targetCardId))).map((row) => row.userId),
    [user.id],
  );
  assert.deepEqual(
    (await db.select({ labelId: cardLabelAssignments.labelId }).from(cardLabelAssignments).where(eq(cardLabelAssignments.cardId, targetCardId))).map((row) => row.labelId),
    [targetSharedLabel.id],
  );
  const targetValues = await db.select().from(cardCustomFieldValues).where(eq(cardCustomFieldValues.cardId, targetCardId));
  assert.equal(targetValues.find((value) => value.fieldId === targetSharedField.id)?.valueText, "Copied value");
  assert.deepEqual(targetValues.find((value) => value.fieldId === targetUserField!.id)?.valueUserIds, [sharedWorkspaceUser!.id], "user fields resolve against workspace membership independently of card assignees");
  assert.equal(targetValues.some((value) => value.fieldId === sourceOnlyField.id), false);
  const [mirroredChecklist] = await db.select().from(cardChecklists).where(and(eq(cardChecklists.cardId, targetCardId), eq(cardChecklists.title, "Independent assignee")));
  assert.equal((await db.select().from(cardChecklistItems).where(eq(cardChecklistItems.checklistId, mirroredChecklist!.id)))[0]?.assigneeId, sharedWorkspaceUser!.id, "checklist-only assignees resolve against target-board eligibility");

  const initialFieldEvents = await db.select().from(eventOutbox).where(and(
    eq(eventOutbox.boardId, targetWorkspace.initialBoard.id),
    eq(eventOutbox.eventType, "card:customFieldValue:set"),
  ));
  assert.ok(initialFieldEvents.some((event) => {
    const payload = event.payload as { cardId?: string; fieldId?: string; valueText?: string };
    return payload.cardId === targetCardId && payload.fieldId === targetSharedField.id && payload.valueText === "Copied value";
  }), "initial mapped field value must be published after card creation");

  const convergedEventTypes = [
    "card:labels:set",
    "card:customFieldValue:set",
    "card:customFieldValue:cleared",
    "card:checklist:created",
    "card:checklist:updated",
    "card:checklist:moved",
    "card:checklist:deleted",
    "card:checklistItem:created",
    "card:checklistItem:updated",
    "card:checklistItem:moved",
    "card:checklistItem:deleted",
  ] as const;
  const eventCountBeforeNoop = (await db.select({ id: eventOutbox.id }).from(eventOutbox).where(and(
    eq(eventOutbox.boardId, targetWorkspace.initialBoard.id),
    inArray(eventOutbox.eventType, [...convergedEventTypes]),
  ))).length;
  await db.update(boardMirrors).set({ reconcileRequestedAt: new Date() }).where(eq(boardMirrors.id, mirror.id));
  await processBoardMirrors();
  const eventCountAfterNoop = (await db.select({ id: eventOutbox.id }).from(eventOutbox).where(and(
    eq(eventOutbox.boardId, targetWorkspace.initialBoard.id),
    inArray(eventOutbox.eventType, [...convergedEventTypes]),
  ))).length;
  assert.equal(eventCountAfterNoop, eventCountBeforeNoop, "a no-op reconcile emits no label, field, or checklist churn");
});
