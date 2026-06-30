import "../../test/setup.integration.js";
import type { WireSearchResults } from "@kanera/shared/dto";
import {
  boardMembers,
  boards,
  cardAttachments,
  cards,
  clients,
  comments,
  lists,
  notes,
  users,
  workspaceMembers,
  workspaces,
} from "@kanera/shared/schema";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { buildIntegrationServer } from "../../test/integration.js";

// Seeds an org with: a plain-member searcher (userA), a second member (userB),
// a workspace-visible board with a card, a private board (no userA membership)
// with a card, a workspace-level team note, and a personal note owned by userB.
async function seed() {
  const [client] = await db.insert(clients).values({ name: "Acme" }).returning();
  const [userA] = await db
    .insert(users)
    .values({ clientId: client!.id, clientRole: "member", email: "a@example.com", passwordHash: "x", displayName: "User A" })
    .returning();
  const [userB] = await db
    .insert(users)
    .values({ clientId: client!.id, clientRole: "member", email: "b@example.com", passwordHash: "x", displayName: "User B" })
    .returning();
  const [workspace] = await db.insert(workspaces).values({ clientId: client!.id, name: "Delivery" }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: workspace!.id, userId: userA!.id, role: "editor" });

  const [publicBoard] = await db
    .insert(boards)
    .values({ workspaceId: workspace!.id, name: "Roadmap", position: "1000.0000000000", visibility: "workspace" })
    .returning();
  const [privateBoard] = await db
    .insert(boards)
    .values({ workspaceId: workspace!.id, name: "Secrets", position: "2000.0000000000", visibility: "private" })
    .returning();
  const [list] = await db
    .insert(lists)
    .values({ workspaceId: workspace!.id, name: "Todo", position: "1000.0000000000" })
    .returning();

  const [publicCard] = await db.insert(cards).values({
    listId: list!.id,
    boardId: publicBoard!.id,
    title: "Synergy onboarding flow",
    position: "1000.0000000000",
    createdById: userA!.id,
  }).returning();
  const [privateCard] = await db.insert(cards).values({
    listId: list!.id,
    boardId: privateBoard!.id,
    title: "Synergy secret roadmap",
    position: "2000.0000000000",
    createdById: userB!.id,
  }).returning();

  await db.insert(cardAttachments).values({
    cardId: publicCard!.id,
    clientId: workspace!.clientId,
    uploadedById: userA!.id,
    fileName: "Launch-checklist.pdf",
    mimeType: "application/pdf",
    byteSize: 1024,
    fileKey: "attachments/launch-checklist.pdf",
    url: "https://cdn.example.test/launch-checklist.pdf",
  });
  await db.insert(cardAttachments).values({
    cardId: privateCard!.id,
    clientId: workspace!.clientId,
    uploadedById: userB!.id,
    fileName: "Launch-secret.pdf",
    mimeType: "application/pdf",
    byteSize: 2048,
    fileKey: "attachments/launch-secret.pdf",
    url: "https://cdn.example.test/launch-secret.pdf",
  });

  await db.insert(notes).values({
    workspaceId: workspace!.id,
    scope: "team",
    ownerId: userB!.id,
    title: "Synergy team note",
    content: "shared planning",
    position: "1000.0000000000",
  });
  await db.insert(notes).values({
    workspaceId: workspace!.id,
    scope: "personal",
    ownerId: userB!.id,
    title: "Synergy personal note",
    content: "private thoughts",
    position: "2000.0000000000",
  });

  return { client: client!, userA: userA!, workspace: workspace! };
}

void test("global search respects board visibility and note ownership", async () => {
  const app = await buildIntegrationServer();
  const { client, userA } = await seed();

  // Mint a JWT for the plain-member searcher (org members, not admins).
  const token = app.jwt.sign({ sub: userA.id, cid: client.id, role: "member" });

  const res = await app.inject({
    method: "GET",
    url: "/search?q=synergy",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<WireSearchResults>();

  const cardTitles = body.cards.map((c) => c.cardTitle).sort();
  // Public-board card is visible; private-board card (no membership) is excluded.
  assert.deepEqual(cardTitles, ["Synergy onboarding flow"]);

  const noteTitles = body.notes.map((n) => n.title).sort();
  // Team note is visible; another user's personal note is excluded.
  assert.deepEqual(noteTitles, ["Synergy team note"]);
});

void test("global search matches partial card titles", async () => {
  const app = await buildIntegrationServer();
  const { client, userA } = await seed();
  const token = app.jwt.sign({ sub: userA.id, cid: client.id, role: "member" });

  const res = await app.inject({
    method: "GET",
    url: "/search?q=onboard",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<WireSearchResults>();

  assert.deepEqual(body.cards.map((c) => c.cardTitle), ["Synergy onboarding flow"]);
});

void test("global search matches partial attachment filenames with board visibility", async () => {
  const app = await buildIntegrationServer();
  const { client, userA } = await seed();
  const token = app.jwt.sign({ sub: userA.id, cid: client.id, role: "member" });

  const res = await app.inject({
    method: "GET",
    url: "/search?q=checkl",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<WireSearchResults>();

  assert.deepEqual(body.attachments.map((a) => a.fileName), ["Launch-checklist.pdf"]);
});

void test("global search lets board-only guests find only their explicit board content", async () => {
  const app = await buildIntegrationServer();
  const [hostClient] = await db.insert(clients).values({ name: "Host" }).returning();
  const [guestClient] = await db.insert(clients).values({ name: "Guest Org" }).returning();
  const [owner] = await db
    .insert(users)
    .values({ clientId: hostClient!.id, clientRole: "owner", email: "host-search@example.com", passwordHash: "x", displayName: "Host" })
    .returning();
  const [guest] = await db
    .insert(users)
    .values({ clientId: guestClient!.id, clientRole: "member", email: "guest-search@example.com", passwordHash: "x", displayName: "Guest" })
    .returning();
  const [workspace] = await db.insert(workspaces).values({ clientId: hostClient!.id, name: "Host Workspace" }).returning();
  const [list] = await db
    .insert(lists)
    .values({ workspaceId: workspace!.id, name: "Todo", position: "1000.0000000000" })
    .returning();
  const [guestBoard] = await db
    .insert(boards)
    .values({ workspaceId: workspace!.id, name: "Guest Board", position: "1000.0000000000", visibility: "workspace" })
    .returning();
  const [otherBoard] = await db
    .insert(boards)
    .values({ workspaceId: workspace!.id, name: "Other Board", position: "2000.0000000000", visibility: "workspace" })
    .returning();
  await db.insert(boardMembers).values({ boardId: guestBoard!.id, userId: guest!.id, role: "observer" });

  const [guestCard] = await db.insert(cards).values({
    listId: list!.id,
    boardId: guestBoard!.id,
    title: "Guestonly shared task",
    position: "1000.0000000000",
    createdById: owner!.id,
  }).returning();
  const [otherCard] = await db.insert(cards).values({
    listId: list!.id,
    boardId: otherBoard!.id,
    title: "Guestonly hidden task",
    position: "2000.0000000000",
    createdById: owner!.id,
  }).returning();
  await db.insert(comments).values([
    { cardId: guestCard!.id, authorId: owner!.id, body: "Guestonly visible comment" },
    { cardId: otherCard!.id, authorId: owner!.id, body: "Guestonly hidden comment" },
  ]);
  await db.insert(cardAttachments).values([
    {
      cardId: guestCard!.id,
      clientId: workspace!.clientId,
      uploadedById: owner!.id,
      fileName: "guestonly-visible.pdf",
      mimeType: "application/pdf",
      byteSize: 1024,
      fileKey: "attachments/guestonly-visible.pdf",
      url: "https://cdn.example.test/guestonly-visible.pdf",
    },
    {
      cardId: otherCard!.id,
      clientId: workspace!.clientId,
      uploadedById: owner!.id,
      fileName: "guestonly-hidden.pdf",
      mimeType: "application/pdf",
      byteSize: 1024,
      fileKey: "attachments/guestonly-hidden.pdf",
      url: "https://cdn.example.test/guestonly-hidden.pdf",
    },
  ]);
  await db.insert(notes).values([
    {
      workspaceId: workspace!.id,
      boardId: guestBoard!.id,
      scope: "team",
      ownerId: owner!.id,
      title: "Guestonly visible board note",
      content: "",
      position: "1000.0000000000",
    },
    {
      workspaceId: workspace!.id,
      scope: "team",
      ownerId: owner!.id,
      title: "Guestonly hidden workspace note",
      content: "",
      position: "2000.0000000000",
    },
    {
      workspaceId: workspace!.id,
      boardId: otherBoard!.id,
      scope: "team",
      ownerId: owner!.id,
      title: "Guestonly hidden board note",
      content: "",
      position: "3000.0000000000",
    },
  ]);

  const token = app.jwt.sign({ sub: guest!.id, cid: guestClient!.id, role: "member" });
  const res = await app.inject({
    method: "GET",
    url: "/search?q=guestonly",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<WireSearchResults>();

  assert.deepEqual(body.cards.map((c) => c.cardTitle), ["Guestonly shared task"]);
  assert.deepEqual(body.comments.map((c) => c.cardTitle), ["Guestonly shared task"]);
  assert.deepEqual(body.attachments.map((a) => a.fileName), ["guestonly-visible.pdf"]);
  assert.deepEqual(body.notes.map((n) => n.title), ["Guestonly visible board note"]);
});
