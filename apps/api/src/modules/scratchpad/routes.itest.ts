import "../../test/setup.integration.js";
import type { ServerEventName, WireScratchpadNote } from "@kanera/shared/events";
import {
  clientMembers,
  clients,
  directRealtimeOutbox,
  eventOutbox,
  scratchpadNoteAttachments,
  scratchpadNotes,
} from "@kanera/shared/schema";
import { asc, eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { getOrgStorageUsage } from "../../lib/entitlements.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { insertTestUsers } from "../../test/user-fixtures.js";

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

/**
 * Two users in ONE organisation, one of them the org owner.
 *
 * Same-org is the load-bearing part of this fixture: the privacy tests below have to prove that
 * `client_id` grants nothing. A cross-org pair would pass those assertions for the wrong reason
 * (ordinary tenancy), leaving the scratchpad's actual privacy rule — the `user_id` half of
 * `(user_id, client_id)` ownership — untested.
 */
async function setup() {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Scratchpad",
      email: "owner-scratchpad@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken: ownerToken, user: owner } = signup
    .json<{ accessToken: string; user: { id: string; clientId: string } }>();

  const [colleague] = await insertTestUsers(db, {
    clientId: owner.clientId,
    email: "colleague-scratchpad@example.com",
    passwordHash: "x",
    displayName: "Colleague",
  }).returning();
  assert.ok(colleague);
  // Deliberately an org *owner* token: the highest authority the product has must still be refused.
  const colleagueToken = app.jwt.sign({ sub: colleague.id, cid: owner.clientId, role: "owner" });

  return { app, owner, ownerToken, colleague, colleagueToken };
}

async function createNote(
  app: Awaited<ReturnType<typeof buildIntegrationServer>>,
  token: string,
  title?: string,
): Promise<WireScratchpadNote> {
  const response = await app.inject({
    method: "POST",
    url: "/scratchpad/notes",
    headers: auth(token),
    payload: title === undefined ? {} : { title },
  });
  assert.equal(response.statusCode, 201);
  return response.json();
}

async function listNotes(
  app: Awaited<ReturnType<typeof buildIntegrationServer>>,
  token: string,
): Promise<WireScratchpadNote[]> {
  const response = await app.inject({ method: "GET", url: "/scratchpad/notes", headers: auth(token) });
  assert.equal(response.statusCode, 200);
  return response.json();
}

function textForm(fileName: string, body: string) {
  const form = new FormData();
  form.append("file", new Blob([body], { type: "text/plain" }), fileName);
  return form;
}

async function directEvents(eventType: ServerEventName) {
  return db
    .select({ id: directRealtimeOutbox.id, userId: directRealtimeOutbox.userId, payload: directRealtimeOutbox.payload })
    .from(directRealtimeOutbox)
    .where(eq(directRealtimeOutbox.eventType, eventType))
    .orderBy(asc(directRealtimeOutbox.id));
}

void test("scratchpad pages are created, listed in order, edited, and deleted", async () => {
  const { app, ownerToken } = await setup();

  const first = await createNote(app, ownerToken, "Today");
  const second = await createNote(app, ownerToken, "Ideas");
  assert.equal(first.title, "Today");
  assert.equal(first.content, "");
  assert.ok(Number(second.position) > Number(first.position), "new pages append after existing ones");

  const edited = await app.inject({
    method: "PATCH",
    url: `/scratchpad/notes/${first.id}`,
    headers: auth(ownerToken),
    payload: { title: "Today (rev)", content: "- ship the thing" },
  });
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.json<WireScratchpadNote>().content, "- ship the thing");

  const listed = await listNotes(app, ownerToken);
  assert.deepEqual(listed.map((note) => note.title), ["Today (rev)", "Ideas"]);
  // The list carries full bodies, not metadata — the panel switches tabs without a second request.
  assert.equal(listed[0]?.content, "- ship the thing");

  const deleted = await app.inject({
    method: "DELETE",
    url: `/scratchpad/notes/${first.id}`,
    headers: auth(ownerToken),
  });
  assert.equal(deleted.statusCode, 204);
  assert.deepEqual((await listNotes(app, ownerToken)).map((note) => note.id), [second.id]);
});

void test("an empty scratchpad update is rejected", async () => {
  const { app, ownerToken } = await setup();
  const note = await createNote(app, ownerToken);

  const response = await app.inject({
    method: "PATCH",
    url: `/scratchpad/notes/${note.id}`,
    headers: auth(ownerToken),
    payload: {},
  });
  assert.equal(response.statusCode, 400);
});

void test("autosave advances updatedAt even when the content is unchanged", async () => {
  const { app, ownerToken } = await setup();
  const note = await createNote(app, ownerToken);

  const first = await app.inject({
    method: "PATCH",
    url: `/scratchpad/notes/${note.id}`,
    headers: auth(ownerToken),
    payload: { content: "same text" },
  });
  assert.equal(first.statusCode, 200);
  const firstSavedAt = new Date(first.json<WireScratchpadNote>().updatedAt).getTime();

  const second = await app.inject({
    method: "PATCH",
    url: `/scratchpad/notes/${note.id}`,
    headers: auth(ownerToken),
    payload: { content: "same text" },
  });
  assert.equal(second.statusCode, 200);
  // The client uses `updatedAt` as its echo watermark. A byte-identical retry that left the timestamp
  // behind would leave the watermark stale and make a later genuine remote edit look like an echo.
  assert.ok(new Date(second.json<WireScratchpadNote>().updatedAt).getTime() >= firstSavedAt);
});

void test("a scratchpad page is invisible to every other user, including an org owner", async () => {
  const { app, ownerToken, colleagueToken } = await setup();
  const note = await createNote(app, ownerToken, "Private");

  for (const request of [
    { method: "PATCH", url: `/scratchpad/notes/${note.id}`, payload: { title: "Leaked" } },
    { method: "PATCH", url: `/scratchpad/notes/${note.id}/move`, payload: { beforeNoteId: null } },
    { method: "DELETE", url: `/scratchpad/notes/${note.id}` },
    { method: "POST", url: `/scratchpad/notes/${note.id}/attachments` },
  ] as const) {
    const response = await app.inject({ ...request, headers: auth(colleagueToken) });
    assert.equal(response.statusCode, 403, `${request.method} ${request.url}`);
  }

  // Listing is isolated, not merely unwritable: the colleague's own scratchpad is empty.
  assert.deepEqual(await listNotes(app, colleagueToken), []);
  const colleagueNote = await createNote(app, colleagueToken, "Mine");
  assert.deepEqual((await listNotes(app, colleagueToken)).map((n) => n.id), [colleagueNote.id]);
  assert.deepEqual((await listNotes(app, ownerToken)).map((n) => n.id), [note.id]);
});

void test("one user gets a separate scratchpad and attachment quota in each organisation", async () => {
  const { app, owner, ownerToken } = await setup();
  const homeNote = await createNote(app, ownerToken, "Home org page");

  const [otherOrg] = await db.insert(clients).values({ name: "Other Scratchpad Org" }).returning();
  assert.ok(otherOrg);
  await db.insert(clientMembers).values({
    clientId: otherOrg.id,
    userId: owner.id,
    clientRole: "member",
  });
  const switched = await app.inject({
    method: "POST",
    url: "/auth/switch-org",
    headers: auth(ownerToken),
    payload: { clientId: otherOrg.id },
  });
  assert.equal(switched.statusCode, 200, switched.body);
  const otherToken = switched.json<{ accessToken: string }>().accessToken;

  assert.deepEqual(await listNotes(app, otherToken), []);
  const otherNote = await createNote(app, otherToken, "Other org page");
  assert.deepEqual((await listNotes(app, otherToken)).map((note) => note.id), [otherNote.id]);
  assert.deepEqual((await listNotes(app, ownerToken)).map((note) => note.id), [homeNote.id]);

  const crossOrgEdit = await app.inject({
    method: "PATCH",
    url: `/scratchpad/notes/${homeNote.id}`,
    headers: auth(otherToken),
    payload: { title: "Wrong org" },
  });
  assert.equal(crossOrgEdit.statusCode, 403);

  const fileBody = "charged to the active org";
  const uploaded = await app.inject({
    method: "POST",
    url: `/scratchpad/notes/${otherNote.id}/attachments`,
    headers: auth(otherToken),
    payload: textForm("quota.txt", fileBody),
  });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  assert.equal((await getOrgStorageUsage(db, owner.clientId)).usedBytes, 0);
  assert.equal((await getOrgStorageUsage(db, otherOrg.id)).usedBytes, Buffer.byteLength(fileBody));
});

void test("scratchpad events reach only the owner's user room and never the webhook outbox", async () => {
  const { app, owner, ownerToken } = await setup();
  const note = await createNote(app, ownerToken, "Private");

  const created = await directEvents("scratchpadNote:created");
  assert.equal(created.length, 1);
  assert.equal(created[0]?.userId, owner.id);

  await app.inject({
    method: "PATCH",
    url: `/scratchpad/notes/${note.id}`,
    headers: auth(ownerToken),
    payload: { content: "secret" },
  });
  const updated = await directEvents("scratchpadNote:updated");
  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.userId, owner.id);
  assert.equal((updated[0]?.payload as { note: WireScratchpadNote }).note.content, "secret");

  // The webhook-leak guard. `event_outbox` is what the dispatcher drains into board/workspace rooms
  // AND into webhook deliveries; a single scratchpad row here would publish a private page's full
  // text to every webhook subscriber in the org.
  const outboxRows = await db
    .select({ eventType: eventOutbox.eventType })
    .from(eventOutbox);
  assert.deepEqual(
    outboxRows.filter((row) => row.eventType.startsWith("scratchpadNote:")),
    [],
    "scratchpad events must never be published to event_outbox",
  );
});

void test("moving a scratchpad page reorders it and reports prevPosition", async () => {
  const { app, ownerToken } = await setup();
  const first = await createNote(app, ownerToken, "A");
  const second = await createNote(app, ownerToken, "B");
  const third = await createNote(app, ownerToken, "C");

  const moved = await app.inject({
    method: "PATCH",
    url: `/scratchpad/notes/${third.id}/move`,
    headers: auth(ownerToken),
    payload: { beforeNoteId: first.id },
  });
  assert.equal(moved.statusCode, 200);
  assert.deepEqual((await listNotes(app, ownerToken)).map((note) => note.title), ["C", "A", "B"]);

  const events = await directEvents("scratchpadNote:moved");
  assert.equal(events.length, 1);
  const payload = events[0]?.payload as { noteId: string; position: string; prevPosition: string };
  assert.equal(payload.noteId, third.id);
  assert.equal(payload.prevPosition, third.position);
  assert.notEqual(payload.position, payload.prevPosition);

  // A reorder is not a document edit: `updatedAt` must not move, or every drag would look like a
  // fresh write and would falsely advance the client's echo watermark.
  const [stored] = await db.select().from(scratchpadNotes).where(eq(scratchpadNotes.id, second.id)).limit(1);
  assert.equal(stored?.updatedAt.getTime(), new Date(second.updatedAt).getTime());
});

void test("an exhausted position gap rebalances, and the rebalanced event precedes moved", async () => {
  const { app, ownerToken } = await setup();
  const first = await createNote(app, ownerToken, "A");
  const second = await createNote(app, ownerToken, "B");
  const third = await createNote(app, ownerToken, "C");

  // Force the gap `between()` reports as exhausted (< 1e-6) rather than dragging ~30 times.
  await db.update(scratchpadNotes).set({ position: "1000.0000000000" }).where(eq(scratchpadNotes.id, first.id));
  await db.update(scratchpadNotes).set({ position: "1000.0000001000" }).where(eq(scratchpadNotes.id, second.id));

  const moved = await app.inject({
    method: "PATCH",
    url: `/scratchpad/notes/${third.id}/move`,
    headers: auth(ownerToken),
    payload: { afterNoteId: first.id },
  });
  assert.equal(moved.statusCode, 200);

  const rebalanced = await directEvents("scratchpadNote:rebalanced");
  assert.equal(rebalanced.length, 1);
  const positions = (rebalanced[0]?.payload as { positions: { id: string; position: string }[] }).positions;
  assert.ok(positions.length > 0);

  // Ordering matters: a client that applied `moved` before `rebalanced` would position the page
  // against numbers the rebalance then renumbers, leaving the tab in the wrong slot.
  const movedEvents = await directEvents("scratchpadNote:moved");
  assert.ok(rebalanced[0]!.id < movedEvents[0]!.id, "rebalanced must be published before moved");

  // Post-rebalance the order is still A, C, B and the positions are cleanly spaced again.
  const listed = await listNotes(app, ownerToken);
  assert.deepEqual(listed.map((note) => note.title), ["A", "C", "B"]);
  assert.deepEqual(listed.map((note) => note.position), [
    "1000.0000000000",
    "2000.0000000000",
    "3000.0000000000",
  ]);
});

void test("embedded media URLs are stored unsigned and re-signed on read", async () => {
  const { app, owner, ownerToken } = await setup();
  const note = await createNote(app, ownerToken);

  const upload = await app.inject({
    method: "POST",
    url: `/scratchpad/notes/${note.id}/attachments`,
    headers: auth(ownerToken),
    payload: textForm("shot.txt", "twelve bytes"),
  });
  assert.equal(upload.statusCode, 201);
  const uploadedUrl = upload.json<{ url: string }>().url;
  assert.ok(uploadedUrl.includes(`/api/media/${owner.clientId}/scratchpad/${note.id}/`));

  const saved = await app.inject({
    method: "PATCH",
    url: `/scratchpad/notes/${note.id}`,
    headers: auth(ownerToken),
    payload: { content: `![shot](${uploadedUrl})` },
  });
  assert.equal(saved.statusCode, 200);

  // Stored form carries no signature — signatures expire, so a persisted one would rot the image.
  const [stored] = await db.select().from(scratchpadNotes).where(eq(scratchpadNotes.id, note.id)).limit(1);
  assert.ok(stored);
  assert.ok(!stored.content.includes("?t="), `stored content should be unsigned: ${stored.content}`);
  assert.ok(stored.content.includes(`/api/media/${owner.clientId}/scratchpad/${note.id}/`));

  // ...and every read hands back a freshly signed URL (`?t=<token>&e=<expiry>`), on the PATCH
  // response and the list alike.
  assert.match(saved.json<WireScratchpadNote>().content, /\?t=[^&)]+&e=\d+/);
  assert.match((await listNotes(app, ownerToken))[0]?.content ?? "", /\?t=[^&)]+&e=\d+/);
});

void test("deleting a scratchpad page hard-deletes its attachment rows and stored objects", async () => {
  const { app, owner, ownerToken } = await setup();
  const note = await createNote(app, ownerToken);

  const upload = await app.inject({
    method: "POST",
    url: `/scratchpad/notes/${note.id}/attachments`,
    headers: auth(ownerToken),
    payload: textForm("shot.txt", "twelve bytes"),
  });
  assert.equal(upload.statusCode, 201);

  const [attachment] = await db
    .select()
    .from(scratchpadNoteAttachments)
    .where(eq(scratchpadNoteAttachments.scratchpadNoteId, note.id))
    .limit(1);
  assert.equal(attachment?.byteSize, 12);
  assert.equal(attachment?.clientId, owner.clientId);
  assert.ok(attachment);
  const storage = await getStorageForClient(owner.clientId);
  assert.equal((await storage.get(attachment.fileKey)).toString(), "twelve bytes");

  // Guards the quota-accounting drift risk: a table missing from `getOrgStorageUsage` is silently
  // free storage with no error anywhere.
  assert.equal((await getOrgStorageUsage(db, owner.clientId)).usedBytes, 12);

  // Uploading must NOT bump the page's updatedAt: the content autosave that carries the embed comes
  // next, and pre-advancing the watermark would make every other session ignore it as an echo.
  const [afterUpload] = await db.select().from(scratchpadNotes).where(eq(scratchpadNotes.id, note.id)).limit(1);
  assert.equal(afterUpload?.updatedAt.getTime(), new Date(note.updatedAt).getTime());

  const deleted = await app.inject({
    method: "DELETE",
    url: `/scratchpad/notes/${note.id}`,
    headers: auth(ownerToken),
  });
  assert.equal(deleted.statusCode, 204);
  assert.deepEqual(
    await db.select().from(scratchpadNoteAttachments).where(eq(scratchpadNoteAttachments.scratchpadNoteId, note.id)),
    [],
  );
  await assert.rejects(storage.get(attachment.fileKey), "scratchpad attachment object should be hard-deleted");
  assert.equal((await getOrgStorageUsage(db, owner.clientId)).usedBytes, 0);
});

void test("removed embeds and failed insertions release their attachment quota", async () => {
  const { app, owner, ownerToken } = await setup();
  const note = await createNote(app, ownerToken);

  const embeddedUpload = await app.inject({
    method: "POST",
    url: `/scratchpad/notes/${note.id}/attachments`,
    headers: auth(ownerToken),
    payload: textForm("embedded.txt", "embedded"),
  });
  assert.equal(embeddedUpload.statusCode, 201);
  const embedded = embeddedUpload.json<{ id: string; url: string }>();

  const saveEmbed = await app.inject({
    method: "PATCH",
    url: `/scratchpad/notes/${note.id}`,
    headers: auth(ownerToken),
    payload: { content: `[embedded](${embedded.url})` },
  });
  assert.equal(saveEmbed.statusCode, 200);

  const removeEmbed = await app.inject({
    method: "PATCH",
    url: `/scratchpad/notes/${note.id}`,
    headers: auth(ownerToken),
    payload: { content: "attachment removed" },
  });
  assert.equal(removeEmbed.statusCode, 200);
  assert.deepEqual(
    await db.select().from(scratchpadNoteAttachments).where(eq(scratchpadNoteAttachments.id, embedded.id)),
    [],
    "saving a body without a previously reachable embed should reclaim its row",
  );

  const failedInsertUpload = await app.inject({
    method: "POST",
    url: `/scratchpad/notes/${note.id}/attachments`,
    headers: auth(ownerToken),
    payload: textForm("failed.txt", "failed"),
  });
  assert.equal(failedInsertUpload.statusCode, 201);
  const failedInsert = failedInsertUpload.json<{ id: string }>();
  const rollback = await app.inject({
    method: "DELETE",
    url: `/scratchpad/notes/${note.id}/attachments/${failedInsert.id}`,
    headers: auth(ownerToken),
  });
  assert.equal(rollback.statusCode, 204);
  assert.equal((await getOrgStorageUsage(db, owner.clientId)).usedBytes, 0);
});

void test("a scratchpad holds at most MAX_SCRATCHPAD_NOTES pages", async () => {
  const { app, owner, ownerToken } = await setup();
  // Seeding directly keeps this test to two requests instead of 50 round trips.
  await db.insert(scratchpadNotes).values(
    Array.from({ length: 50 }, (_unused, index) => ({
      userId: owner.id,
      clientId: owner.clientId,
      title: `Page ${index}`,
      position: ((index + 1) * 1000).toFixed(10),
    })),
  );

  const blocked = await app.inject({
    method: "POST",
    url: "/scratchpad/notes",
    headers: auth(ownerToken),
    payload: {},
  });
  assert.equal(blocked.statusCode, 400);
  assert.equal((await listNotes(app, ownerToken)).length, 50);
});

void test("concurrent creates cannot both slip past the page cap", async () => {
  const { app, owner, ownerToken } = await setup();
  await db.insert(scratchpadNotes).values(
    Array.from({ length: 49 }, (_unused, index) => ({
      userId: owner.id,
      clientId: owner.clientId,
      title: `Page ${index}`,
      position: ((index + 1) * 1000).toFixed(10),
    })),
  );

  const responses = await Promise.all([
    app.inject({ method: "POST", url: "/scratchpad/notes", headers: auth(ownerToken), payload: {} }),
    app.inject({ method: "POST", url: "/scratchpad/notes", headers: auth(ownerToken), payload: {} }),
  ]);

  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 400]);
  const listed = await listNotes(app, ownerToken);
  assert.equal(listed.length, 50);
  assert.equal(new Set(listed.map((note) => note.position)).size, 50);
});

/**
 * The scratchpad is app-server-only: `scratchpadRoutes` is never registered on the public API, and
 * `authenticateApiKey` refuses to authenticate outside `/api/v1/`. No API key can reach these
 * routes at all, so the `assertWriteCapableCredential` calls in the handlers are a backstop for the
 * day the scratchpad is exposed publicly, not live enforcement.
 *
 * This pins the outer layer. Relaxing that URL gate must not silently hand a read-scoped agent
 * credential write access to the owner's private pages.
 */
void test("an API key cannot reach the scratchpad at all", async () => {
  const { app, ownerToken } = await setup();
  const note = await createNote(app, ownerToken, "Private");

  const keyCreated = await app.inject({
    method: "POST",
    url: "/me/api-keys",
    headers: auth(ownerToken),
    payload: { label: "Agent", scope: "read" },
  });
  assert.equal(keyCreated.statusCode, 201, keyCreated.body);
  const keyAuth = auth(keyCreated.json<{ secret: string }>().secret);

  // 401, not 403: the credential never authenticates here, so the route guard is never consulted.
  const reads = await app.inject({ method: "GET", url: "/scratchpad/notes", headers: keyAuth });
  assert.equal(reads.statusCode, 401, reads.body);
  const created = await app.inject({ method: "POST", url: "/scratchpad/notes", headers: keyAuth, payload: { title: "Nope" } });
  assert.equal(created.statusCode, 401, created.body);
  const patched = await app.inject({ method: "PATCH", url: `/scratchpad/notes/${note.id}`, headers: keyAuth, payload: { content: "Nope" } });
  assert.equal(patched.statusCode, 401, patched.body);
  const moved = await app.inject({ method: "PATCH", url: `/scratchpad/notes/${note.id}/move`, headers: keyAuth, payload: {} });
  assert.equal(moved.statusCode, 401, moved.body);
  const removed = await app.inject({ method: "DELETE", url: `/scratchpad/notes/${note.id}`, headers: keyAuth });
  assert.equal(removed.statusCode, 401, removed.body);

  // The owner's interactive session is unaffected, and the page survived every attempt.
  const listed = await listNotes(app, ownerToken);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, note.id);
});
