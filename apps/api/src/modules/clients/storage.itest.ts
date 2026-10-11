import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { StorageFilesResponse, StorageOverviewResponse } from "@kanera/shared/dto";
import { STORAGE_WARNING_PERCENT } from "@kanera/shared/dto";
import { activityEvents, boards, cardAttachments, cards, clients, emailQueue, lists, noteAttachments, notes } from "@kanera/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { hashPassword } from "../../auth/password.js";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { unsignedMediaUrl } from "../../lib/media-keys.js";
import { runStorageWarningSweep } from "../../lib/storage-warning.js";
import { signupOwner } from "../../test/api-fixtures.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { insertTestUsers } from "../../test/user-fixtures.js";

function textForm(fileName: string, body: string) {
  const form = new FormData();
  form.append("file", new Blob([body], { type: "text/plain" }), fileName);
  return form;
}

async function setupOrg(seed: string) {
  const app = await buildIntegrationServer();
  const owner = await signupOwner(app, { seed });
  const created = await app.inject({ method: "POST", url: "/workspaces", headers: owner.auth, payload: { name: "Delivery" } });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  const [board] = await db.insert(boards).values({ workspaceId: workspace.id, name: "Roadmap", position: "1000.0000000000" }).returning();
  const [card] = await db.insert(cards).values({
    listId: list!.id,
    boardId: board!.id,
    title: "Launch assets",
    position: "1000.0000000000",
    createdById: owner.user.id,
  }).returning();
  return { app, owner, workspace, card: card! };
}

async function insertNote(workspaceId: string, ownerId: string, scope: "team" | "personal", title: string) {
  const [note] = await db.insert(notes).values({
    workspaceId,
    scope,
    ownerId,
    lastEditedById: ownerId,
    title,
    position: "1000.0000000000",
  }).returning();
  return note!;
}

async function insertNoteAttachment(clientId: string, noteId: string, uploadedById: string, fileName: string, byteSize: number) {
  const [row] = await db.insert(noteAttachments).values({
    clientId,
    noteId,
    uploadedById,
    fileName,
    mimeType: "application/pdf",
    byteSize,
    fileKey: `${clientId}/notes/${noteId}/${fileName}`,
    url: `/media/${clientId}/notes/${noteId}/${fileName}`,
  }).returning();
  return row!;
}

void test("storage overview, listing and cleanup cover card and team-note files but never personal ones", async () => {
  const { app, owner, workspace, card } = await setupOrg("storage-cleanup");
  const clientId = owner.user.clientId;

  const upload = await app.inject({
    method: "POST",
    url: `/cards/${card.id}/attachments`,
    headers: owner.auth,
    payload: textForm("brief.txt", "x".repeat(4000)),
  });
  assert.equal(upload.statusCode, 201);
  const cardAttachment = upload.json<{ id: string }>();
  // The description embeds the file, so the cleanup must strip it exactly as a manual delete does.
  const [stored] = await db.select().from(cardAttachments).where(eq(cardAttachments.id, cardAttachment.id));
  await db.update(cards).set({ description: `See ![brief](${unsignedMediaUrl(clientId, stored!.fileKey)})`, archivedAt: new Date() }).where(eq(cards.id, card.id));

  const teamNote = await insertNote(workspace.id, owner.user.id, "team", "Specs");
  const personalNote = await insertNote(workspace.id, owner.user.id, "personal", "Private");
  const teamFile = await insertNoteAttachment(clientId, teamNote.id, owner.user.id, "spec.pdf", 9000);
  const personalFile = await insertNoteAttachment(clientId, personalNote.id, owner.user.id, "diary.pdf", 500);

  const overview = await app.inject({ method: "GET", url: "/clients/me/storage", headers: owner.auth });
  assert.equal(overview.statusCode, 200);
  const body = overview.json<StorageOverviewResponse>();
  assert.equal(body.warningPercent, STORAGE_WARNING_PERCENT);
  assert.equal(body.usage.usedBytes, 4000 + 9000 + 500);
  assert.deepEqual(
    Object.fromEntries(body.categories.map((category) => [category.key, [category.bytes, category.count]])),
    { cards: [4000, 1], notes: [9000, 1], personal: [500, 1] },
  );
  assert.equal(body.workspaces.length, 1);
  assert.equal(body.workspaces[0]!.workspaceId, workspace.id);
  // Personal files count toward the pool but are not attributed to a workspace listing.
  assert.equal(body.workspaces[0]!.bytes, 13000);

  const listed = await app.inject({ method: "GET", url: "/clients/me/storage/files", headers: owner.auth });
  assert.equal(listed.statusCode, 200);
  const files = listed.json<StorageFilesResponse>();
  assert.equal(files.total, 2);
  assert.equal(files.totalBytes, 13000);
  assert.deepEqual(files.items.map((file) => [file.kind, file.fileName]), [["note", "spec.pdf"], ["card", "brief.txt"]]);
  const cardRow = files.items.find((file) => file.kind === "card")!;
  assert.equal(cardRow.archived, true);
  assert.equal(cardRow.cardTitle, "Launch assets");
  assert.ok(cardRow.cardKey);

  const filtered = await app.inject({ method: "GET", url: "/clients/me/storage/files?kind=card&archivedOnly=true&minBytes=1000", headers: owner.auth });
  assert.deepEqual(filtered.json<StorageFilesResponse>().items.map((file) => file.id), [cardAttachment.id]);
  const none = await app.inject({ method: "GET", url: "/clients/me/storage/files?olderThanDays=30", headers: owner.auth });
  assert.equal(none.json<StorageFilesResponse>().total, 0);
  const notArchived = await app.inject({ method: "GET", url: "/clients/me/storage/files?archivedOnly=false", headers: owner.auth });
  assert.equal(notArchived.json<StorageFilesResponse>().total, 2);

  const deleted = await app.inject({
    method: "POST",
    url: "/clients/me/storage/files/delete",
    headers: owner.auth,
    payload: { files: [
      { kind: "card", id: cardAttachment.id },
      { kind: "note", id: teamFile.id },
      // Personal files are refused silently, like ids from another organisation.
      { kind: "note", id: personalFile.id },
    ] },
  });
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(deleted.json(), { deletedCount: 2, freedBytes: 13000 });

  assert.equal((await db.select().from(cardAttachments).where(eq(cardAttachments.id, cardAttachment.id))).length, 0);
  assert.equal((await db.select().from(noteAttachments).where(eq(noteAttachments.id, teamFile.id))).length, 0);
  assert.equal((await db.select().from(noteAttachments).where(eq(noteAttachments.id, personalFile.id))).length, 1);
  const [updatedCard] = await db.select().from(cards).where(eq(cards.id, card.id));
  assert.equal(updatedCard!.description, "See");
  // The card's history shows the removal, as it would for a manual delete, so a purge by an admin
  // is still attributable on the card.
  const history = await db.select({ action: activityEvents.action }).from(activityEvents)
    .where(and(eq(activityEvents.entityId, card.id), sql`${activityEvents.action} like 'attachment%'`));
  assert.deepEqual(history, [{ action: "attachment_removed" }]);

  await app.close();
});

void test("storage management is limited to organisation admins", async () => {
  const { app, owner } = await setupOrg("storage-admin-only");
  const [member] = await insertTestUsers(db, {
    clientId: owner.user.clientId,
    clientRole: "member",
    email: "storage-member@example.com",
    passwordHash: await hashPassword("Abc12345"),
    displayName: "Member",
  }).returning();
  const memberAuth = { authorization: `Bearer ${app.jwt.sign({ sub: member!.id, cid: owner.user.clientId, role: "member" })}` };

  for (const request of [
    { method: "GET" as const, url: "/clients/me/storage" },
    { method: "GET" as const, url: "/clients/me/storage/files" },
    { method: "POST" as const, url: "/clients/me/storage/files/delete", payload: { files: [{ kind: "card", id: "019ed5a7-8b12-7e60-8599-3f0069ce728f" }] } },
  ]) {
    const response = await app.inject({ ...request, headers: memberAuth });
    assert.equal(response.statusCode, 403, `${request.method} ${request.url}`);
  }
  await app.close();
});

void test("the storage warning emails owners once per approach and re-arms after a cleanup", async () => {
  const { app, owner, card } = await setupOrg("storage-warning");
  const clientId = owner.user.clientId;
  const config = { ...env, KANERA_DEPLOYMENT_MODE: "hosted" as const, HOSTED_FREE_STORAGE_QUOTA_BYTES: 1000 };
  const [attachment] = await db.insert(cardAttachments).values({
    cardId: card.id,
    clientId,
    uploadedById: owner.user.id,
    fileName: "big.bin",
    mimeType: "application/octet-stream",
    byteSize: 700,
    fileKey: `${clientId}/cards/${card.id}/big.bin`,
    url: `/media/${clientId}/cards/${card.id}/big.bin`,
  }).returning();
  const warnings = async () => db.select().from(emailQueue)
    .where(and(eq(emailQueue.type, "storage_warning"), eq(emailQueue.toEmail, owner.email)));

  // 70%: below the warning line.
  await runStorageWarningSweep(app.mailer, undefined, config);
  assert.equal((await warnings()).length, 0);

  await db.update(cardAttachments).set({ byteSize: 850 }).where(eq(cardAttachments.id, attachment!.id));
  await runStorageWarningSweep(app.mailer, undefined, config);
  await runStorageWarningSweep(app.mailer, undefined, config);
  const sent = await warnings();
  assert.equal(sent.length, 1, "a second sweep while still near the limit must not email again");
  assert.equal((sent[0]!.data as { percentUsed: number }).percentUsed, 85);
  assert.equal((sent[0]!.data as { storageUrl: string }).storageUrl, `${env.WEB_ORIGIN}/settings/storage`);
  assert.ok((sent[0]!.data as { upgradeQuotaLabel: string | null }).upgradeQuotaLabel, "a Free org is told what upgrading adds");

  // 75% is inside the hysteresis band: still armed-off.
  await db.update(cardAttachments).set({ byteSize: 750 }).where(eq(cardAttachments.id, attachment!.id));
  await runStorageWarningSweep(app.mailer, undefined, config);
  const [stillSent] = await db.select({ at: clients.storageWarningSentAt }).from(clients).where(eq(clients.id, clientId));
  assert.ok(stillSent!.at);

  // A cleanup to 50% re-arms, and the next approach warns again.
  await db.update(cardAttachments).set({ byteSize: 500 }).where(eq(cardAttachments.id, attachment!.id));
  await runStorageWarningSweep(app.mailer, undefined, config);
  const [rearmed] = await db.select({ at: clients.storageWarningSentAt }).from(clients).where(eq(clients.id, clientId));
  assert.equal(rearmed!.at, null);
  await db.update(cardAttachments).set({ byteSize: 900 }).where(eq(cardAttachments.id, attachment!.id));
  await runStorageWarningSweep(app.mailer, undefined, config);
  assert.equal((await warnings()).length, 2);

  // Self-hosted has no quota and never warns.
  await db.update(clients).set({ storageWarningSentAt: null }).where(eq(clients.id, clientId));
  assert.equal(await runStorageWarningSweep(app.mailer, undefined, { ...config, KANERA_DEPLOYMENT_MODE: "self_hosted" as const }), 0);
  await app.close();
});
