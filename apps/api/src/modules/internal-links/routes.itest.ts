import "../../test/setup.integration.js";
import { boardMembers, boards, cards, internalLinks, lists, notes, users, workspaceMembers } from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { buildIntegrationServer } from "../../test/integration.js";

void test("POST /internal-links/resolve resolves accessible card and board links", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Links",
      email: "owner-links@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json();

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);

  const [board] = await db.insert(boards).values({
    workspaceId: workspace.id,
    name: "Launch Board",
    icon: "rocket",
    iconColor: "blue",
    position: "1000.0000000000",
    visibility: "workspace",
  }).returning();
  assert.ok(board);

  const [card] = await db.insert(cards).values({
    listId: list.id,
    boardId: board.id,
    title: "Write release notes",
    position: "1000.0000000000",
    createdById: user.id,
  }).returning();
  assert.ok(card);

  const cardUrl = `/b/${board.id}/c/${card.id}`;
  const queryCardUrl = `/b/${board.id}?cardId=${card.id}`;
  const boardUrl = `http://web.test/b/${board.id}`;
  const externalUrl = "https://example.com/b/123e4567-e89b-12d3-a456-426614174000";
  const response = await app.inject({
    method: "POST",
    url: "/internal-links/resolve",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { urls: [cardUrl, queryCardUrl, boardUrl, externalUrl] },
  });
  assert.equal(response.statusCode, 200);

  const body = response.json();
  assert.equal(body.links[cardUrl].kind, "card");
  assert.equal(body.links[cardUrl].title, "Write release notes");
  assert.equal(body.links[cardUrl].boardName, "Launch Board");
  assert.equal(body.links[cardUrl].listName, list.name);
  assert.equal(body.links[cardUrl].boardIcon, "rocket");
  assert.equal(body.links[cardUrl].boardIconColor, "blue");
  assert.equal(body.links[cardUrl].href, cardUrl);
  assert.equal(body.links[queryCardUrl].kind, "card");
  assert.equal(body.links[queryCardUrl].title, "Write release notes");
  assert.equal(body.links[queryCardUrl].href, queryCardUrl);
  assert.equal(body.links[boardUrl].kind, "board");
  assert.equal(body.links[boardUrl].title, "Launch Board");
  assert.equal(body.links[boardUrl].icon, "rocket");
  assert.equal(body.links[boardUrl].iconColor, "blue");
  assert.equal(body.links[externalUrl], undefined);
});

void test("note URLs resolve and saved markdown maintains card-note backlinks", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Note Links",
      email: "owner-note-links@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);

  const [board] = await db.insert(boards).values({
    workspaceId: workspace.id,
    name: "Launch Board",
    position: "1000.0000000000",
    visibility: "workspace",
  }).returning();
  assert.ok(board);
  const [card] = await db.insert(cards).values({
    listId: list.id,
    boardId: board.id,
    title: "Launch checklist",
    position: "1000.0000000000",
    createdById: user.id,
  }).returning();
  assert.ok(card);
  const [relatedCard] = await db.insert(cards).values({
    listId: list.id,
    boardId: board.id,
    title: "Publish announcement",
    position: "2000.0000000000",
    createdById: user.id,
  }).returning();
  assert.ok(relatedCard);
  const [note] = await db.insert(notes).values({
    workspaceId: workspace.id,
    boardId: null,
    scope: "team",
    ownerId: user.id,
    title: "Launch runbook",
    icon: "book",
    color: "emerald",
    position: "1000.0000000000",
  }).returning();
  assert.ok(note);
  const [relatedNote] = await db.insert(notes).values({
    workspaceId: workspace.id,
    boardId: null,
    scope: "team",
    ownerId: user.id,
    title: "Launch comms",
    icon: "speakerphone",
    position: "2000.0000000000",
  }).returning();
  assert.ok(relatedNote);

  const noteUrl = `/w/${workspace.id}/notes?noteId=${note.id}`;
  const resolve = await app.inject({
    method: "POST",
    url: "/internal-links/resolve",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { urls: [noteUrl] },
  });
  assert.equal(resolve.statusCode, 200);
  assert.equal(resolve.json().links[noteUrl].kind, "note");
  assert.equal(resolve.json().links[noteUrl].title, "Launch runbook");
  // resolved note links carry the note color so rendered chips can tint the icon
  assert.equal(resolve.json().links[noteUrl].color, "emerald");

  const cardPatched = await app.inject({
    method: "PATCH",
    url: `/cards/${card.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { description: `See ${noteUrl}` },
  });
  assert.equal(cardPatched.statusCode, 200);

  const cardLinks = await db.select().from(internalLinks).where(and(eq(internalLinks.sourceType, "card"), eq(internalLinks.sourceId, card.id)));
  assert.equal(cardLinks.length, 1);
  assert.equal(cardLinks[0]!.targetType, "note");
  assert.equal(cardLinks[0]!.targetId, note.id);
  const originalCardLink = cardLinks[0]!;

  const detail = await app.inject({
    method: "GET",
    url: `/cards/${card.id}/detail`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(detail.statusCode, 200);
  assert.deepEqual(detail.json().linkedNotes.map((n: { id: string }) => n.id), [note.id]);
  const linksAfterCleanRepair = await db.select().from(internalLinks).where(and(eq(internalLinks.sourceType, "card"), eq(internalLinks.sourceId, card.id)));
  assert.equal(linksAfterCleanRepair.length, 1);
  assert.equal(linksAfterCleanRepair[0]!.id, originalCardLink.id);
  assert.deepEqual(linksAfterCleanRepair[0]!.createdAt, originalCardLink.createdAt);

  await db.insert(internalLinks).values({
    workspaceId: workspace.id,
    sourceType: "card",
    sourceId: card.id,
    targetType: "board",
    targetId: board.id,
  });
  const detailAfterStaleLink = await app.inject({
    method: "GET",
    url: `/cards/${card.id}/detail`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(detailAfterStaleLink.statusCode, 200);
  const linksAfterStaleRepair = await db.select().from(internalLinks).where(and(eq(internalLinks.sourceType, "card"), eq(internalLinks.sourceId, card.id)));
  assert.equal(linksAfterStaleRepair.length, 1);
  assert.equal(linksAfterStaleRepair[0]!.targetType, "note");
  assert.equal(linksAfterStaleRepair[0]!.targetId, note.id);

  const backlinks = await app.inject({
    method: "GET",
    url: `/notes/${note.id}/backlinks`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(backlinks.statusCode, 200);
  assert.deepEqual(backlinks.json().backlinks.map((b: { kind: string; id: string }) => `${b.kind}:${b.id}`), [`card:${card.id}`]);

  const notePatched = await app.inject({
    method: "PATCH",
    url: `/notes/${note.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { content: `/b/${board.id}?cardId=${card.id}`, baseUpdatedAt: note.updatedAt.toISOString() },
  });
  assert.equal(notePatched.statusCode, 200);
  const noteLinks = await db.select().from(internalLinks).where(and(eq(internalLinks.sourceType, "note"), eq(internalLinks.sourceId, note.id)));
  assert.equal(noteLinks.length, 1);
  assert.equal(noteLinks[0]!.targetType, "card");
  assert.equal(noteLinks[0]!.targetId, card.id);

  const absoluteNoteUrl = new URL(`/w/${workspace.id}/notes?noteId=${note.id}`, env.WEB_ORIGIN).toString();
  const cardPatchedWithAutolink = await app.inject({
    method: "PATCH",
    url: `/cards/${card.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { description: `See <${absoluteNoteUrl}>.` },
  });
  assert.equal(cardPatchedWithAutolink.statusCode, 200);
  const autolinkCardLinks = await db.select().from(internalLinks).where(and(eq(internalLinks.sourceType, "card"), eq(internalLinks.sourceId, card.id)));
  assert.equal(autolinkCardLinks.length, 1);
  assert.equal(autolinkCardLinks[0]!.targetType, "note");
  assert.equal(autolinkCardLinks[0]!.targetId, note.id);

  const absoluteCardUrl = new URL(`/b/${board.id}?cardId=${card.id}`, env.WEB_ORIGIN).toString();
  const notePatchedWithAutolink = await app.inject({
    method: "PATCH",
    url: `/notes/${note.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { content: `See <${absoluteCardUrl}>.`, baseUpdatedAt: notePatched.json().updatedAt },
  });
  assert.equal(notePatchedWithAutolink.statusCode, 200);
  const autolinkNoteLinks = await db.select().from(internalLinks).where(and(eq(internalLinks.sourceType, "note"), eq(internalLinks.sourceId, note.id)));
  assert.equal(autolinkNoteLinks.length, 1);
  assert.equal(autolinkNoteLinks[0]!.targetType, "card");
  assert.equal(autolinkNoteLinks[0]!.targetId, card.id);

  const relatedNotePatched = await app.inject({
    method: "PATCH",
    url: `/notes/${relatedNote.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { content: `Related ${noteUrl}`, baseUpdatedAt: relatedNote.updatedAt.toISOString() },
  });
  assert.equal(relatedNotePatched.statusCode, 200);
  const noteBacklinks = await app.inject({
    method: "GET",
    url: `/notes/${note.id}/backlinks`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(noteBacklinks.statusCode, 200);
  assert.ok(noteBacklinks.json().backlinks.some((b: { kind: string; id: string }) => b.kind === "note" && b.id === relatedNote.id));

  const relatedCardUrl = `/b/${board.id}?cardId=${relatedCard.id}`;
  const cardPatchedWithCardLink = await app.inject({
    method: "PATCH",
    url: `/cards/${card.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { description: `Depends on ${relatedCardUrl}` },
  });
  assert.equal(cardPatchedWithCardLink.statusCode, 200);
  const detailWithCardLink = await app.inject({
    method: "GET",
    url: `/cards/${card.id}/detail`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(detailWithCardLink.statusCode, 200);
  assert.ok(detailWithCardLink.json().linkedNotes.some((item: { kind: string; id: string }) => item.kind === "card" && item.id === relatedCard.id));
});

void test("POST /internal-links/resolve does not leak inaccessible private links", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Private Links",
      email: "owner-private-links@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user: owner } = signup.json();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json();

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);

  const [privateBoard] = await db.insert(boards).values({
    workspaceId: workspace.id,
    name: "Private Roadmap",
    position: "1000.0000000000",
    visibility: "private",
  }).returning();
  assert.ok(privateBoard);
  await db.insert(boardMembers).values({ boardId: privateBoard.id, userId: owner.id, role: "owner" });

  const [privateCard] = await db.insert(cards).values({
    listId: list.id,
    boardId: privateBoard.id,
    title: "Secret card",
    position: "1000.0000000000",
    createdById: owner.id,
  }).returning();
  assert.ok(privateCard);

  const [member] = await db.insert(users).values({
    clientId: owner.clientId,
    email: "member-private-links@example.com",
    passwordHash: "test",
    displayName: "Member",
  }).returning();
  assert.ok(member);
  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: member.id, role: "editor" });
  const memberToken = app.jwt.sign({ sub: member.id, cid: owner.clientId, role: "member" });

  const cardUrl = `/b/${privateBoard.id}/c/${privateCard.id}`;
  const response = await app.inject({
    method: "POST",
    url: "/internal-links/resolve",
    headers: { authorization: `Bearer ${memberToken}` },
    payload: { urls: [cardUrl, `/b/${privateBoard.id}`] },
  });
  assert.equal(response.statusCode, 200);

  const body = response.json();
  assert.deepEqual(body.links, {});
});
