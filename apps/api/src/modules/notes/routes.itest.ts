import "../../test/setup.integration.js";
import { insertTestUsers } from "../../test/user-fixtures.js";
import { boardMembers, boards, cards, clients, internalLinks, lists, noteAttachments, notes, workspaceMembers } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db, pool } from "../../db.js";
import { env } from "../../env.js";
import { buildPublicApiServer } from "../../public-api-server.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { signupOwner } from "../../test/api-fixtures.js";

async function setupWorkspace() {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Notes",
      email: "owner-notes@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken: ownerToken, user: owner } = signup.json();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json();

  // Editing a workspace team note requires workspace admin (shared workspace content), so the second
  // user contending for the lock is another admin, not a plain member.
  const [otherAdmin] = await insertTestUsers(db, {
      clientId: owner.clientId,
      email: "admin-notes@example.com",
      passwordHash: "x",
      displayName: "Other Admin",
      avatarUrl: `/api/media/${owner.clientId}/avatars/other-admin.webp`,
    })
    .returning();
  assert.ok(otherAdmin);

  await db.insert(workspaceMembers).values({
    workspaceId: workspace.id,
    userId: otherAdmin.id,
    role: "admin",
  });

  const otherAdminToken = app.jwt.sign({ sub: otherAdmin.id, cid: owner.clientId, role: "admin" });

  const createdNote = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/notes`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { scope: "team", title: "Team note" },
  });
  assert.equal(createdNote.statusCode, 201);

  return {
    app,
    owner,
    ownerToken,
    otherAdmin,
    otherAdminToken,
    workspace,
    note: createdNote.json(),
  };
}

function textForm(fileName: string, body: string) {
  const form = new FormData();
  form.append("file", new Blob([body], { type: "text/plain" }), fileName);
  return form;
}

function svgForm(fileName: string) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>',
    ], { type: "image/svg+xml" }),
    fileName,
  );
  return form;
}

function mediaPath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname.replace(/^\/api/, "")}${parsed.search}`;
}

void test("empty note updates are rejected without advancing editor timestamps", async () => {
  const { app, ownerToken, note } = await setupWorkspace();
  const before = new Date(note.updatedAt as string).getTime();

  const response = await app.inject({
    method: "PATCH",
    url: `/notes/${note.id}`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { baseUpdatedAt: note.updatedAt },
  });
  assert.equal(response.statusCode, 400);

  const [stored] = await db.select({ updatedAt: notes.updatedAt }).from(notes).where(eq(notes.id, note.id)).limit(1);
  assert.equal(stored?.updatedAt.getTime(), before);
});

void test("note backlinks do not wait for internal-link repair", async () => {
  const { app, ownerToken, owner, workspace, note } = await setupWorkspace();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Repair source", position: "1000.0000000000" })
    .returning();
  assert.ok(list);
  assert.ok(board);
  const [card] = await db
    .insert(cards)
    .values({
      boardId: board.id,
      listId: list.id,
      title: "Repair source",
      description: `stale reference ${note.id}`,
      position: "1000.0000000000",
      createdById: owner.id,
    })
    .returning();
  assert.ok(card);
  const [link] = await db
    .insert(internalLinks)
    .values({
      workspaceId: workspace.id,
      sourceType: "card",
      sourceId: card.id,
      targetType: "board",
      targetId: board.id,
    })
    .returning();
  assert.ok(link);

  const lock = await pool.connect();
  let request: Promise<{ statusCode: number }> | undefined;
  try {
    await lock.query("begin");
    await lock.query(`select id from "internal_link" where id = $1 for update`, [link.id]);
    request = app.inject({
      method: "GET",
      url: `/notes/${note.id}/backlinks`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const activeRequest = request;
    const completedWithoutRepair = await Promise.race([
      activeRequest.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    assert.equal(completedWithoutRepair, true);
  } finally {
    await lock.query("rollback");
    lock.release();
  }
  assert.equal((await request!).statusCode, 200);
  for (let attempt = 0; attempt < 40 && await db.$count(internalLinks, eq(internalLinks.id, link.id)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(await db.$count(internalLinks, eq(internalLinks.id, link.id)), 0);
});

void test("team note locks can be acquired and renewed by the same user", async () => {
  const { app, ownerToken, owner, note } = await setupWorkspace();

  const first = await app.inject({
    method: "POST",
    url: `/notes/${note.id}/lock`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: {},
  });
  assert.equal(first.statusCode, 200);
  const firstLock = first.json();
  assert.equal(firstLock.editingUserId, owner.id);
  assert.equal(firstLock.editingUserName, "Owner");

  const renewed = await app.inject({
    method: "POST",
    url: `/notes/${note.id}/lock`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: {},
  });
  assert.equal(renewed.statusCode, 200);
  assert.equal(renewed.json().editingUserId, owner.id);
});

void test("note responses identify the last editor and expose a signed avatar", async () => {
  const { app, owner, otherAdmin, otherAdminToken, note } = await setupWorkspace();
  assert.equal(note.lastEditedById, owner.id);
  assert.equal(note.lastEditedByName, "Owner");
  assert.equal(note.lastEditedByAvatarUrl, null);
  assert.ok(note.lastEditedAt);

  const updated = await app.inject({
    method: "PATCH",
    url: `/notes/${note.id}`,
    headers: { authorization: `Bearer ${otherAdminToken}` },
    payload: { content: "Edited by the other admin", baseUpdatedAt: note.updatedAt },
  });
  assert.equal(updated.statusCode, 200);
  const body = updated.json();
  assert.equal(body.lastEditedById, otherAdmin.id);
  assert.equal(body.lastEditedByName, "Other Admin");
  assert.match(body.lastEditedByAvatarUrl, /avatars\/other-admin\.webp/);
  assert.match(body.lastEditedByAvatarUrl, /[?&]t=/);

  const listed = await app.inject({
    method: "GET",
    url: `/workspaces/${note.workspaceId}/notes?scope=team`,
    headers: { authorization: `Bearer ${otherAdminToken}` },
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json()[0].lastEditedByName, "Other Admin");
});

void test("another user is blocked while a team note lock is active", async () => {
  const { app, ownerToken, otherAdminToken, otherAdmin, note } = await setupWorkspace();

  const locked = await app.inject({
    method: "POST",
    url: `/notes/${note.id}/lock`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: {},
  });
  assert.equal(locked.statusCode, 200);

  const otherLock = await app.inject({
    method: "POST",
    url: `/notes/${note.id}/lock`,
    headers: { authorization: `Bearer ${otherAdminToken}` },
    payload: {},
  });
  assert.equal(otherLock.statusCode, 409);
  assert.equal(otherLock.json().code, "NOTE_LOCKED");
  assert.equal(otherLock.json().lock.editingUserName, "Owner");

  const otherUpdate = await app.inject({
    method: "PATCH",
    url: `/notes/${note.id}`,
    headers: { authorization: `Bearer ${otherAdminToken}` },
    payload: { content: "Other admin edit", baseUpdatedAt: note.updatedAt },
  });
  assert.equal(otherUpdate.statusCode, 409);
  assert.equal(otherUpdate.json().code, "NOTE_LOCKED");

  const [stored] = await db.select().from(notes).where(eq(notes.id, note.id)).limit(1);
  assert.notEqual(stored?.editingUserId, otherAdmin.id);
});

void test("expired team note locks can be acquired by another user", async () => {
  const { app, ownerToken, otherAdminToken, otherAdmin, note } = await setupWorkspace();

  const locked = await app.inject({
    method: "POST",
    url: `/notes/${note.id}/lock`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: {},
  });
  assert.equal(locked.statusCode, 200);

  await db
    .update(notes)
    .set({ editingExpiresAt: new Date(Date.now() - 1000) })
    .where(eq(notes.id, note.id));

  const otherLock = await app.inject({
    method: "POST",
    url: `/notes/${note.id}/lock`,
    headers: { authorization: `Bearer ${otherAdminToken}` },
    payload: {},
  });
  assert.equal(otherLock.statusCode, 200);
  assert.equal(otherLock.json().editingUserId, otherAdmin.id);
});

void test("stale note saves return NOTE_STALE with the latest note", async () => {
  const { app, ownerToken, note } = await setupWorkspace();

  const firstUpdate = await app.inject({
    method: "PATCH",
    url: `/notes/${note.id}`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { content: "First edit", baseUpdatedAt: note.updatedAt },
  });
  assert.equal(firstUpdate.statusCode, 200);

  const staleUpdate = await app.inject({
    method: "PATCH",
    url: `/notes/${note.id}`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { content: "Stale edit", baseUpdatedAt: note.updatedAt },
  });
  assert.equal(staleUpdate.statusCode, 409);
  assert.equal(staleUpdate.json().code, "NOTE_STALE");
  assert.equal(staleUpdate.json().note.content, "First edit");
});

void test("new personal notes can be renamed with their returned wire timestamp", async () => {
  const { app, ownerToken, workspace } = await setupWorkspace();

  const created = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/notes`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { scope: "personal", title: "Untitled" },
  });
  assert.equal(created.statusCode, 201);
  const note = created.json();

  const renamed = await app.inject({
    method: "PATCH",
    url: `/notes/${note.id}`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { title: "Project thoughts", baseUpdatedAt: note.updatedAt },
  });

  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.json().title, "Project thoughts");
});

void test("notes accept a palette color on create and update, and clear it back to null", async () => {
  const { app, ownerToken, workspace } = await setupWorkspace();

  const created = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/notes`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { scope: "personal", title: "Colored", color: "emerald" },
  });
  assert.equal(created.statusCode, 201);
  const note = created.json();
  assert.equal(note.color, "emerald");

  const recolored = await app.inject({
    method: "PATCH",
    url: `/notes/${note.id}`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { color: "sky" },
  });
  assert.equal(recolored.statusCode, 200);
  assert.equal(recolored.json().color, "sky");

  const cleared = await app.inject({
    method: "PATCH",
    url: `/notes/${note.id}`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { color: null },
  });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json().color, null);
});

void test("personal notes stay owner-only while duplicate and move preserve their private collection", async () => {
  const { app, ownerToken, otherAdminToken, owner, workspace } = await setupWorkspace();

  const firstParentResponse = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/notes`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { scope: "personal", title: "Private parent" },
  });
  assert.equal(firstParentResponse.statusCode, 201);
  const firstParent = firstParentResponse.json();

  const sourceResponse = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/notes`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: {
      scope: "personal",
      parentNoteId: firstParent.id,
      title: "Private plan",
      icon: "lock",
      color: "violet",
    },
  });
  assert.equal(sourceResponse.statusCode, 201);
  const source = sourceResponse.json();

  const editedResponse = await app.inject({
    method: "PATCH",
    url: `/notes/${source.id}`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { content: "Private content with [a link](https://example.com)." },
  });
  assert.equal(editedResponse.statusCode, 200);

  const duplicatedResponse = await app.inject({
    method: "POST",
    url: `/notes/${source.id}/duplicate`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: {},
  });
  assert.equal(duplicatedResponse.statusCode, 201);
  const duplicate = duplicatedResponse.json();
  assert.equal(duplicate.title, "Private plan copy");
  assert.equal(duplicate.content, "Private content with [a link](https://example.com).");
  assert.equal(duplicate.icon, "lock");
  assert.equal(duplicate.color, "violet");
  assert.equal(duplicate.scope, "personal");
  assert.equal(duplicate.ownerId, owner.id);
  assert.equal(duplicate.parentNoteId, firstParent.id);

  const secondParentResponse = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/notes`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { scope: "personal", title: "Second private parent" },
  });
  assert.equal(secondParentResponse.statusCode, 201);
  const secondParent = secondParentResponse.json();

  const movedResponse = await app.inject({
    method: "PATCH",
    url: `/notes/${duplicate.id}/move`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { parentNoteId: secondParent.id },
  });
  assert.equal(movedResponse.statusCode, 200);
  assert.equal(movedResponse.json().parentNoteId, secondParent.id);

  const otherList = await app.inject({
    method: "GET",
    url: `/workspaces/${workspace.id}/notes?scope=personal`,
    headers: { authorization: `Bearer ${otherAdminToken}` },
  });
  assert.equal(otherList.statusCode, 200);
  assert.deepEqual(otherList.json(), []);

  for (const request of [
    { method: "GET", url: `/notes/${duplicate.id}` },
    { method: "PATCH", url: `/notes/${duplicate.id}`, payload: { title: "Leaked" } },
    { method: "POST", url: `/notes/${duplicate.id}/duplicate`, payload: {} },
    { method: "PATCH", url: `/notes/${duplicate.id}/move`, payload: { parentNoteId: null } },
    { method: "GET", url: `/notes/${duplicate.id}/attachments` },
  ] as const) {
    const response = await app.inject({
      ...request,
      headers: { authorization: `Bearer ${otherAdminToken}` },
    });
    assert.equal(response.statusCode, 403, `${request.method} ${request.url}`);
  }
});

void test("a new child note inherits the parent's color unless one is supplied", async () => {
  const { app, ownerToken, workspace } = await setupWorkspace();

  const parent = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/notes`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { scope: "personal", title: "Parent", color: "emerald" },
  });
  assert.equal(parent.statusCode, 201);
  const parentId = parent.json().id;

  // No color given → inherits the parent's color.
  const inherited = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/notes`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { scope: "personal", title: "Child", parentNoteId: parentId },
  });
  assert.equal(inherited.statusCode, 201);
  assert.equal(inherited.json().color, "emerald");

  // Explicit color on a child wins over inheritance.
  const explicit = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/notes`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { scope: "personal", title: "Child 2", parentNoteId: parentId, color: "sky" },
  });
  assert.equal(explicit.statusCode, 201);
  assert.equal(explicit.json().color, "sky");

  // Recoloring the parent does not propagate to existing children.
  await app.inject({
    method: "PATCH",
    url: `/notes/${parentId}`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { color: "rose" },
  });
  const reloaded = await app.inject({
    method: "GET",
    url: `/notes/${inherited.json().id}`,
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(reloaded.json().color, "emerald");
});

void test("note attachments count toward hosted storage quota and profile usage", async () => {
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  const previousFreeQuota = env.HOSTED_FREE_STORAGE_QUOTA_BYTES;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  env.HOSTED_FREE_STORAGE_QUOTA_BYTES = 20;
  try {
    const { app, owner, ownerToken, note } = await setupWorkspace();
    await db.update(clients).set({ plan: "free", billingStatus: "none" }).where(eq(clients.id, owner.clientId));

    const first = await app.inject({
      method: "POST",
      url: `/notes/${note.id}/attachments`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: textForm("note.txt", "twelve bytes"),
    });
    assert.equal(first.statusCode, 201);

    const [stored] = await db.select().from(noteAttachments).where(eq(noteAttachments.noteId, note.id)).limit(1);
    assert.equal(stored?.byteSize, 12);
    assert.equal(stored?.clientId, owner.clientId);

    const blocked = await app.inject({
      method: "POST",
      url: `/notes/${note.id}/attachments`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: textForm("blocked.txt", "nine more"),
    });
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.json<{ code: string }>().code, "STORAGE_QUOTA_EXCEEDED");

    const me = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json<{ storageUsage: { usedBytes: number } }>().storageUsage.usedBytes, 12);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
    env.HOSTED_FREE_STORAGE_QUOTA_BYTES = previousFreeQuota;
  }
});

void test("note description attachments are listed with signed downloadable URLs", async () => {
  const { app, ownerToken, note } = await setupWorkspace();

  const upload = await app.inject({
    method: "POST",
    url: `/notes/${note.id}/attachments?source=description`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: svgForm("note-description.svg"),
  });
  assert.equal(upload.statusCode, 201);
  const attachment = upload.json<{ id: string; url: string; source: string }>();
  assert.equal(attachment.source, "description");
  assert.equal(new URL(attachment.url).searchParams.get("fn"), "note-description.svg");

  const mediaUrl = new URL(attachment.url);
  const download = await app.inject({
    method: "GET",
    url: `${mediaUrl.pathname.replace(/^\/api/, "")}${mediaUrl.search}`,
  });
  assert.equal(download.statusCode, 200);
  assert.equal(
    download.headers["content-disposition"],
    `attachment; filename="note-description.svg"; filename*=UTF-8''note-description.svg`,
  );

  const update = await app.inject({
    method: "PATCH",
    url: `/notes/${note.id}`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { content: `Before\n\n![Inline note image](${attachment.url})\n\nAfter`, baseUpdatedAt: note.updatedAt },
  });
  assert.equal(update.statusCode, 200);
  assert.match(update.json<{ content: string }>().content, /!\[Inline note image\]\([^)]*\/media\/[^)]+\)/);

  const listed = await app.inject({
    method: "GET",
    url: `/notes/${note.id}/attachments`,
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(
    listed.json<Array<{ id: string; source: string }>>().map((item) => ({ id: item.id, source: item.source })),
    [{ id: attachment.id, source: "description" }],
  );
});

void test("cross-org board guests receive stored note attachment media URLs", async () => {
  const { app, owner, ownerToken, workspace } = await setupWorkspace();

  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Guest Notes", position: "1000.0000000000" })
    .returning();
  assert.ok(board);

  const createdNote = await app.inject({
    method: "POST",
    url: `/boards/${board.id}/notes`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { scope: "team", title: "Board note" },
  });
  assert.equal(createdNote.statusCode, 201);
  const note = createdNote.json<{ id: string }>();

  const guestSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "External Notes", email: "board-note-guest@example.com", password: "Abc12345", displayName: "Guest" },
  });
  assert.equal(guestSignup.statusCode, 200);
  const guest = guestSignup.json<{ accessToken: string; user: { id: string; clientId: string } }>();
  assert.notEqual(guest.user.clientId, owner.clientId);
  await db.insert(boardMembers).values({ boardId: board.id, userId: guest.user.id, role: "editor" });

  const hostUpload = await app.inject({
    method: "POST",
    url: `/notes/${note.id}/attachments`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: textForm("host-note.txt", "host file"),
  });
  assert.equal(hostUpload.statusCode, 201);
  const hostAttachment = hostUpload.json<{ id: string; url: string }>();
  assert.match(new URL(hostAttachment.url).pathname, new RegExp(`/api/media/${owner.clientId}/`));

  const guestList = await app.inject({
    method: "GET",
    url: `/notes/${note.id}/attachments`,
    headers: { authorization: `Bearer ${guest.accessToken}` },
  });
  assert.equal(guestList.statusCode, 200);
  const guestRows = guestList.json<Array<{ id: string; url: string }>>();
  assert.equal(guestRows.find((row) => row.id === hostAttachment.id)?.id, hostAttachment.id);
  const guestVisibleHostAttachment = guestRows.find((row) => row.id === hostAttachment.id)!;
  assert.match(new URL(guestVisibleHostAttachment.url).pathname, new RegExp(`/api/media/${owner.clientId}/`));
  const hostDownloadAsGuest = await app.inject({ method: "GET", url: mediaPath(guestVisibleHostAttachment.url) });
  assert.equal(hostDownloadAsGuest.statusCode, 200);

  const guestUpload = await app.inject({
    method: "POST",
    url: `/notes/${note.id}/attachments`,
    headers: { authorization: `Bearer ${guest.accessToken}` },
    payload: textForm("guest-note.txt", "guest file"),
  });
  assert.equal(guestUpload.statusCode, 201);
  const guestAttachment = guestUpload.json<{ id: string; url: string }>();
  assert.match(new URL(guestAttachment.url).pathname, new RegExp(`/api/media/${guest.user.clientId}/`));

  const editedNote = await app.inject({
    method: "GET",
    url: `/notes/${note.id}`,
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(editedNote.statusCode, 200);
  assert.equal(editedNote.json().lastEditedById, guest.user.id);
  assert.equal(editedNote.json().lastEditedByName, "Guest");

  const hostList = await app.inject({
    method: "GET",
    url: `/notes/${note.id}/attachments`,
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(hostList.statusCode, 200);
  const hostRows = hostList.json<Array<{ id: string; url: string }>>();
  const hostVisibleGuestAttachment = hostRows.find((row) => row.id === guestAttachment.id);
  assert.ok(hostVisibleGuestAttachment);
  assert.match(new URL(hostVisibleGuestAttachment.url).pathname, new RegExp(`/api/media/${guest.user.clientId}/`));
  const guestDownloadAsHost = await app.inject({ method: "GET", url: mediaPath(hostVisibleGuestAttachment.url) });
  assert.equal(guestDownloadAsHost.statusCode, 200);
});

void test("direct note attachments can be listed and deleted, stripping inline references", async () => {
  const { app, ownerToken, note } = await setupWorkspace();

  const upload = await app.inject({
    method: "POST",
    url: `/notes/${note.id}/attachments`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: textForm("note.txt", "hello note"),
  });
  assert.equal(upload.statusCode, 201);
  const attachment = upload.json<{ id: string; url: string; source: string }>();
  assert.equal(attachment.source, "attachment");

  const update = await app.inject({
    method: "PATCH",
    url: `/notes/${note.id}`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { content: `See [note file](${attachment.url})`, baseUpdatedAt: note.updatedAt },
  });
  assert.equal(update.statusCode, 200);

  const deleted = await app.inject({
    method: "DELETE",
    url: `/notes/${note.id}/attachments/${attachment.id}`,
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(deleted.statusCode, 204);

  const listed = await app.inject({
    method: "GET",
    url: `/notes/${note.id}/attachments`,
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json(), []);

  const fetched = await app.inject({
    method: "GET",
    url: `/notes/${note.id}`,
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.json<{ content: string }>().content.trim(), "See");
});

void test("users outside the workspace cannot delete note attachments", async () => {
  const { app, ownerToken, note } = await setupWorkspace();

  const upload = await app.inject({
    method: "POST",
    url: `/notes/${note.id}/attachments`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: textForm("private.txt", "private"),
  });
  assert.equal(upload.statusCode, 201);
  const attachment = upload.json<{ id: string }>();

  const { accessToken: outsiderToken } = await signupOwner(app, { orgName: "Other Org", email: "outsider-notes@example.com", displayName: "Outsider" });

  const deleted = await app.inject({
    method: "DELETE",
    url: `/notes/${note.id}/attachments/${attachment.id}`,
    headers: { authorization: `Bearer ${outsiderToken}` },
  });
  assert.equal(deleted.statusCode, 403);
});

void test("saving a locked team note clears the holder lock", async () => {
  const { app, ownerToken, note } = await setupWorkspace();

  const locked = await app.inject({
    method: "POST",
    url: `/notes/${note.id}/lock`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: {},
  });
  assert.equal(locked.statusCode, 200);

  const update = await app.inject({
    method: "PATCH",
    url: `/notes/${note.id}`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { content: "Saved", baseUpdatedAt: note.updatedAt },
  });
  assert.equal(update.statusCode, 200);
  assert.equal(update.json().content, "Saved");
  assert.equal(update.json().editingUserId, null);
  assert.equal(update.json().editingExpiresAt, null);
});

void test("a read-scoped personal API key can read but not write notes", async () => {
  // The fixture is untyped (setupWorkspace returns whatever signup.json() hands back), so narrow
  // the fields this test uses to keep the unsafe-any lint warnings out of the new block.
  const { app, ownerToken, workspace, note } = await setupWorkspace() as {
    app: Awaited<ReturnType<typeof buildIntegrationServer>>;
    ownerToken: string;
    workspace: { id: string };
    note: { id: string };
  };
  const keyCreated = await app.inject({
    method: "POST",
    url: "/me/api-keys",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { label: "Agent", scope: "read" },
  });
  assert.equal(keyCreated.statusCode, 201, keyCreated.body);
  const keyAuth = { authorization: `Bearer ${keyCreated.json<{ secret: string }>().secret}` };

  // Notes are reachable by API keys through the public API server, so the read-scope gate in
  // authoriseWrite/the create routes is live enforcement, not just defense-in-depth.
  const publicApi = await buildPublicApiServer({ logger: false, rateLimit: { enabled: false } });
  try {
    // Reads resolve through the owner's access.
    const detail = await publicApi.inject({ method: "GET", url: `/api/v1/notes/${note.id}`, headers: keyAuth });
    assert.equal(detail.statusCode, 200, detail.body);

    // Personal-scope writes pass at plain member/observer, so the gate must catch them explicitly —
    // this is the surface a read-only key would otherwise leak writes into.
    const createPersonal = await publicApi.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspace.id}/notes`,
      headers: keyAuth,
      payload: { scope: "personal", title: "Nope" },
    });
    assert.equal(createPersonal.statusCode, 403, createPersonal.body);
    const patch = await publicApi.inject({ method: "PATCH", url: `/api/v1/notes/${note.id}`, headers: keyAuth, payload: { title: "Nope" } });
    assert.equal(patch.statusCode, 403, patch.body);
  } finally {
    await publicApi.close();
  }

  // The owner's interactive session keeps full write access on the app server.
  const ownerCreate = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/notes`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { scope: "personal", title: "Mine" },
  });
  assert.equal(ownerCreate.statusCode, 201);
});
