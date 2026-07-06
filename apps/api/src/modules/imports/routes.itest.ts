import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { CommitImportBody } from "@kanera/shared/dto";
import { activityEvents, boards, cardAttachments, cardChecklists, cards, clients, comments, eventOutbox, kaneraBoardImports, lists, trelloImports } from "@kanera/shared/schema";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { buildBoardExportArchive } from "../../lib/board-export.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { runTrelloImport } from "./importer.js";
import { runKaneraBoardImport } from "./kanera-importer.js";
import { parseKaneraBoardExport } from "./kanera-parser.js";
import type { NormalizedTrelloBoard } from "./types.js";

type SignupResponse = { accessToken: string; user: { id: string; clientId: string } };
type WorkspaceResponse = { id: string };
type ImportResult = { createdBoardId: string; cards: { created: number }; comments: number; checklists: number; attachments: { imported: number; skipped: number }; warnings: string[] };

async function waitForOutboxEvent(boardId: string, eventType: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const rows = await db.select().from(eventOutbox).where(eq(eventOutbox.scopeId, boardId)).orderBy(asc(eventOutbox.createdAt), asc(eventOutbox.id));
    if (rows.some((row) => row.eventType === eventType)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return db.select().from(eventOutbox).where(eq(eventOutbox.scopeId, boardId)).orderBy(asc(eventOutbox.createdAt), asc(eventOutbox.id));
}

async function waitForImportOutboxEvents(workspaceId: string, boardId: string, eventTypes: string[]) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const rows = await db
      .select()
      .from(eventOutbox)
      .where(inArray(eventOutbox.scopeId, [workspaceId, boardId]))
      .orderBy(asc(eventOutbox.createdAt), asc(eventOutbox.id));
    if (eventTypes.every((eventType) => rows.some((row) => row.eventType === eventType))) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return db
    .select()
    .from(eventOutbox)
    .where(inArray(eventOutbox.scopeId, [workspaceId, boardId]))
    .orderBy(asc(eventOutbox.createdAt), asc(eventOutbox.id));
}

async function withHosted<T>(fn: () => Promise<T>): Promise<T> {
  const previous = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  try {
    return await fn();
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previous;
  }
}

async function setFreeTier(clientId: string) {
  await db.update(clients).set({ plan: "free", billingStatus: "none" }).where(eq(clients.id, clientId));
}

void test("POST /imports/:importId/commit imports a ready Trello session", async () => {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Import Co",
      email: "owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<SignupResponse>();

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Migration" },
  });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<WorkspaceResponse>();
  const otherCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Other workspace" },
  });
  assert.equal(otherCreated.statusCode, 201);
  const otherWorkspace = otherCreated.json<WorkspaceResponse>();

  const source: NormalizedTrelloBoard = {
    board: { id: "trello-board", name: "Trello Launch", desc: "Imported board" },
    lists: [
      { id: "trello-list", name: "Todo", closed: false, pos: 1 },
      { id: "closed-list", name: "Done forever", closed: true, pos: 2 },
    ],
    labels: [{ id: "trello-label", name: "Important", color: "red" }],
    customFields: [],
    members: [{ id: "trello-member", fullName: "Owner", username: "owner" }],
    cards: [
      {
        id: "trello-card",
        name: "Move card",
        desc: "Card body",
        listId: "trello-list",
        pos: 1,
        closed: false,
        due: "2026-01-01T09:00:00.000Z",
        dueComplete: false,
        labelIds: ["trello-label"],
        memberIds: ["trello-member"],
        checklistIds: ["trello-checklist"],
        customFieldItems: [],
        attachments: [{ id: "trello-link", name: "Spec.txt", url: "https://example.com/spec.txt", isUpload: false, mimeType: "text/plain", byteSize: 4 }],
      },
      {
        id: "failed-attachment-card",
        name: "Keep Trello link",
        desc: null,
        listId: "trello-list",
        pos: 2,
        closed: false,
        due: null,
        dueComplete: false,
        labelIds: [],
        memberIds: [],
        checklistIds: [],
        customFieldItems: [],
        attachments: [{ id: "private-link", name: "Private.pdf", url: "https://example.com/private.pdf", isUpload: true, mimeType: "application/pdf", byteSize: 4 }],
      },
      {
        id: "closed-list-card",
        name: "Should stay archived",
        desc: null,
        listId: "closed-list",
        pos: 3,
        closed: false,
        due: null,
        dueComplete: false,
        labelIds: [],
        memberIds: [],
        checklistIds: [],
        customFieldItems: [],
        attachments: [],
      },
    ],
    checklists: [{
      id: "trello-checklist",
      name: "Prep",
      pos: 1,
      items: [{ id: "trello-item", name: "Review", pos: 1, state: "complete" }],
    }],
    comments: [{
      id: "trello-comment",
      cardId: "trello-card",
      memberId: "trello-member",
      memberName: "Owner",
      text: "Looks good",
      date: "2026-01-02T10:00:00.000Z",
    }],
  };
  const importId = randomUUID();
  await db.insert(trelloImports).values({
    id: importId,
    workspaceId: workspace.id,
    clientId: user.clientId,
    createdById: user.id,
    status: "ready",
    sourceFileKey: `imports/${importId}/source.json`,
    sourceFileName: "trello.json",
    manifest: { board: { name: source.board.name, desc: source.board.desc }, lists: [], labels: [], customFields: [], members: [], counts: { cards: 3, checklists: 1, comments: 1, linkAttachments: 1, uploadedAttachments: 1 } },
    source,
  });

  const [foreignList] = await db.insert(lists).values({
    workspaceId: otherWorkspace.id,
    name: "Foreign",
    position: "1000.0000000000",
  }).returning();
  const forgedImportId = randomUUID();
  await db.insert(trelloImports).values({
    id: forgedImportId,
    workspaceId: workspace.id,
    clientId: user.clientId,
    createdById: user.id,
    status: "ready",
    sourceFileKey: `imports/${forgedImportId}/source.json`,
    sourceFileName: "trello.json",
    manifest: { board: { name: source.board.name, desc: source.board.desc }, lists: [], labels: [], customFields: [], members: [], counts: { cards: 1, checklists: 0, comments: 0, linkAttachments: 0, uploadedAttachments: 0 } },
    source,
  });
  const forged = await app.inject({
    method: "POST",
    url: `/imports/${forgedImportId}/commit`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      board: { name: "Forged" },
      lists: { "trello-list": { action: "map", targetListId: foreignList!.id }, "closed-list": { action: "skip" } },
      labels: { "trello-label": { action: "skip" } },
      customFields: {},
      members: { "trello-member": user.id },
      options: { includeArchived: false, importComments: false, importCustomFields: true },
    },
  });
  assert.equal(forged.statusCode, 400);

  const committed = await app.inject({
    method: "POST",
    url: `/imports/${importId}/commit`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      board: { name: "Imported Launch" },
      lists: {
        "trello-list": { action: "create", name: "Imported Todo" },
        "closed-list": { action: "create", name: "Closed" },
      },
      labels: { "trello-label": { action: "create", name: "Important", color: "red" } },
      customFields: {},
      members: { "trello-member": user.id },
      options: { includeArchived: false, importComments: true, importCustomFields: true },
    },
  });
  assert.equal(committed.statusCode, 200);
  const result = committed.json<ImportResult>();
  assert.equal(result.cards.created, 2);
  assert.equal(result.comments, 1);
  assert.equal(result.checklists, 1);
  assert.equal(result.attachments.imported, 0);
  assert.equal(result.attachments.skipped, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("attachment links were preserved")));
  assert.ok(result.warnings.some((warning) => warning.includes("Trello list was archived")));

  const [board] = await db.select().from(boards).where(eq(boards.id, result.createdBoardId)).limit(1);
  assert.equal(board?.name, "Imported Launch");
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).orderBy(lists.createdAt).limit(1);
  assert.ok(list);
  const importedCards = await db.select().from(cards).where(eq(cards.boardId, result.createdBoardId));
  assert.equal(importedCards.length, 2);
  assert.equal(importedCards.some((candidate) => candidate.title === "Should stay archived"), false);
  const card = importedCards.find((candidate) => candidate.title === "Move card");
  assert.equal(card?.title, "Move card");
  assert.equal(card?.description?.includes("Imported Trello attachments"), true);
  assert.equal(card?.description?.includes("https://example.com/spec.txt"), true);
  assert.equal(card?.dueDateLocalDate, "2026-01-01");
  assert.equal(card?.dueDateSlot, "anyTime");
  const failedAttachmentCard = importedCards.find((candidate) => candidate.title === "Keep Trello link");
  assert.equal(failedAttachmentCard?.description?.includes("https://example.com/private.pdf"), true);
  const importedAttachments = await db.select().from(cardAttachments).where(eq(cardAttachments.cardId, card!.id));
  assert.equal(importedAttachments.length, 0);
  const importedComments = await db.select().from(comments).where(eq(comments.cardId, card!.id));
  assert.equal(importedComments.length, 1);
  assert.equal(importedComments[0]?.body, "Looks good");
  const importedChecklists = await db.select().from(cardChecklists).where(eq(cardChecklists.cardId, card!.id));
  assert.equal(importedChecklists.length, 1);
  const importActivities = await db.select().from(activityEvents).where(eq(activityEvents.boardId, result.createdBoardId));
  assert.ok(importActivities.some((activity) => activity.entityType === "card" && activity.action === "created"));
  const outboxRows = await waitForImportOutboxEvents(workspace.id, result.createdBoardId, ["board:created", "list:created", "cardLabel:created", "card:created"]);
  assert.ok(outboxRows.some((row) => row.eventType === "card:created"));
  const firstCardCreated = outboxRows.findIndex((row) => row.eventType === "card:created");
  assert.ok(firstCardCreated > outboxRows.findIndex((row) => row.eventType === "board:created"));
  assert.ok(firstCardCreated > outboxRows.findIndex((row) => row.eventType === "list:created"));
  assert.ok(firstCardCreated > outboxRows.findIndex((row) => row.eventType === "cardLabel:created"));
});

void test("Trello import commit is blocked by the org-wide free board cap", async () => {
  await withHosted(async () => {
    const app = await buildIntegrationServer();
    const signup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { orgName: "Trello Limit Co", email: "owner-trello-limit@example.com", password: "Abc12345", displayName: "Owner" },
    });
    assert.equal(signup.statusCode, 200);
    const { accessToken, user } = signup.json<SignupResponse>();
    await setFreeTier(user.clientId);

    const created = await app.inject({ method: "POST", url: "/workspaces", headers: { authorization: `Bearer ${accessToken}` }, payload: { name: "Migration" } });
    assert.equal(created.statusCode, 201);
    const workspace = created.json<WorkspaceResponse>();
    await db.insert(boards).values([1, 2, 3].map((i) => ({ workspaceId: workspace.id, name: `Existing ${i}`, position: `${i * 1000}.0000000000` })));

    const source: NormalizedTrelloBoard = {
      board: { id: "trello-board", name: "Imported", desc: null },
      lists: [{ id: "trello-list", name: "Todo", closed: false, pos: 1 }],
      labels: [],
      customFields: [],
      members: [],
      cards: [],
      checklists: [],
      comments: [],
    };
    const importId = randomUUID();
    await db.insert(trelloImports).values({
      id: importId,
      workspaceId: workspace.id,
      clientId: user.clientId,
      createdById: user.id,
      status: "ready",
      sourceFileKey: `imports/${importId}/source.json`,
      sourceFileName: "trello.json",
      manifest: { board: { name: source.board.name, desc: source.board.desc }, lists: [], labels: [], customFields: [], members: [], counts: { cards: 0, checklists: 0, comments: 0, linkAttachments: 0, uploadedAttachments: 0 } },
      source,
    });

    const committed = await app.inject({
      method: "POST",
      url: `/imports/${importId}/commit`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        board: { name: "Imported" },
        lists: { "trello-list": { action: "skip" } },
        labels: {},
        customFields: {},
        members: {},
        options: { includeArchived: false, importComments: false, importCustomFields: false, attachmentCopyMode: "skip" },
      },
    });
    assert.equal(committed.statusCode, 403);
    assert.equal(committed.json<{ code: string }>().code, "PLAN_LIMIT");
  });
});

void test("Kanera board import commit is blocked by the org-wide free board cap", async () => {
  await withHosted(async () => {
    const { app, auth, user, workspace, existingBoard } = await setupImportTarget("Kanera Limit Co", "owner-kanera-limit@example.com");
    await setFreeTier(user.clientId);
    await db.insert(boards).values([
      { workspaceId: workspace.id, name: "Second", position: "2000.0000000000" },
      { workspaceId: workspace.id, name: "Third", position: "3000.0000000000" },
    ]);

    const archive = await buildBoardExportArchive(existingBoard.id, user.clientId);
    const parsed = parseKaneraBoardExport(archive);
    const importId = randomUUID();
    await db.insert(kaneraBoardImports).values({
      id: importId,
      workspaceId: workspace.id,
      clientId: user.clientId,
      createdById: user.id,
      status: "ready",
      sourceFileKey: `imports/kanera-board/${importId}/source.json`,
      sourceFileName: "kanera.json",
      manifest: parsed.manifest,
      source: parsed.source,
    });

    const committed = await app.inject({
      method: "POST",
      url: `/imports/kanera-board/${importId}/commit`,
      headers: auth,
      payload: {
        board: { name: "Imported Kanera" },
        lists: {},
        labels: {},
        customFields: {},
        members: {},
        options: { includeArchived: false, importComments: false, importCustomFields: false, attachmentCopyMode: "skip" },
      },
    });
    assert.equal(committed.statusCode, 403);
    assert.equal(committed.json<{ code: string }>().code, "PLAN_LIMIT");
  });
});

async function setupImportTarget(testName: string, email: string) {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: testName, email, password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<SignupResponse>();
  const auth = { authorization: `Bearer ${accessToken}` };

  const created = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Delivery" } });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<WorkspaceResponse>();

  // A workspace list already populated with a card on an existing board. Imports
  // map onto this list, so imported cards must append after this tail rather than
  // restart at position 1000 and interleave the existing card.
  const [targetList] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(targetList);
  const [existingBoard] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Existing", position: "1000.0000000000" })
    .returning();
  assert.ok(existingBoard);
  const [existingCard] = await db
    .insert(cards)
    .values({ listId: targetList.id, boardId: existingBoard.id, title: "Existing tail", position: "5000.0000000000", createdById: user.id })
    .returning();
  assert.ok(existingCard);

  return { app, auth, user, workspace, targetList, existingBoard, existingCard };
}

void test("Trello import appends mapped-list cards after the workspace-list tail", async () => {
  const { user, workspace, targetList, existingCard } = await setupImportTarget("Acme Trello Tail", "owner-trello-tail@example.com");

  const source: NormalizedTrelloBoard = {
    board: { id: "trello-board", name: "Imported", desc: null },
    lists: [{ id: "trello-list", name: "Todo", closed: false, pos: 1 }],
    labels: [],
    customFields: [],
    members: [{ id: "trello-member", fullName: "Owner", username: "owner" }],
    cards: [
      { id: "trello-card-1", name: "Imported first", desc: null, listId: "trello-list", pos: 1, closed: false, due: null, dueComplete: false, labelIds: [], memberIds: [], checklistIds: [], customFieldItems: [], attachments: [] },
      { id: "trello-card-2", name: "Imported second", desc: null, listId: "trello-list", pos: 2, closed: false, due: null, dueComplete: false, labelIds: [], memberIds: [], checklistIds: [], customFieldItems: [], attachments: [] },
    ],
    checklists: [],
    comments: [],
  };

  const body: CommitImportBody = {
    board: { name: "Imported" },
    lists: { "trello-list": { action: "map", targetListId: targetList.id } },
    labels: {},
    customFields: {},
    members: { "trello-member": user.id },
    options: { includeArchived: false, importComments: false, importCustomFields: false, attachmentCopyMode: "skip" },
  };

  const result = await db.transaction((tx) =>
    runTrelloImport(tx, { source, body, workspaceId: workspace.id, clientId: user.clientId, actorId: user.id, actorTimezone: "UTC" })
  );

  const targetCards = await db
    .select({ title: cards.title, position: cards.position })
    .from(cards)
    .where(and(eq(cards.listId, targetList.id), isNull(cards.archivedAt)))
    .orderBy(asc(cards.position));

  assert.deepEqual(targetCards.map((c) => c.title), ["Existing tail", "Imported first", "Imported second"]);
  // The imported cards sit strictly after the pre-existing tail, with unique positions.
  const imported = targetCards.filter((c) => c.title !== "Existing tail");
  assert.ok(imported.every((c) => Number(c.position) > Number(existingCard.position)));
  assert.equal(new Set(targetCards.map((c) => c.position)).size, targetCards.length);
  assert.equal(result.board.workspaceId, workspace.id);
});

void test("Kanera board import appends mapped-list cards after the workspace-list tail", async () => {
  const { user, workspace, targetList, existingCard } = await setupImportTarget("Acme Kanera Tail", "owner-kanera-tail@example.com");

  // Build a real export archive from a throwaway source board, then import it into
  // the populated target list to exercise the shared tail-positioning path.
  const [sourceBoard] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Source", position: "9000.0000000000" })
    .returning();
  assert.ok(sourceBoard);
  const [sourceList] = await db
    .insert(lists)
    .values({ workspaceId: workspace.id, name: "Source list", position: "9000.0000000000" })
    .returning();
  assert.ok(sourceList);
  await db.insert(cards).values([
    { listId: sourceList.id, boardId: sourceBoard.id, title: "Exported first", position: "1000.0000000000", createdById: user.id },
    { listId: sourceList.id, boardId: sourceBoard.id, title: "Exported second", position: "2000.0000000000", createdById: user.id },
  ]);

  const archive = await buildBoardExportArchive(sourceBoard.id, user.clientId);
  const exportedList = archive.lists.find((l) => l.id === sourceList.id);
  assert.ok(exportedList);

  const body: CommitImportBody = {
    board: { name: "Imported Kanera" },
    lists: { [exportedList.id]: { action: "map", targetListId: targetList.id } },
    labels: {},
    customFields: {},
    members: {},
    options: { includeArchived: false, importComments: false, importCustomFields: false, attachmentCopyMode: "skip" },
  };

  const storage = await getStorageForClient(user.clientId);
  const result = await db.transaction((tx) =>
    runKaneraBoardImport(tx, { source: archive, body, workspaceId: workspace.id, clientId: user.clientId, actorId: user.id, storage })
  );

  const targetCards = await db
    .select({ boardId: cards.boardId, title: cards.title, position: cards.position })
    .from(cards)
    .where(and(eq(cards.listId, targetList.id), isNull(cards.archivedAt)))
    .orderBy(asc(cards.position));

  // The exported board's positions (1000/2000) must not be reused verbatim; they
  // are remapped after the existing tail while preserving their relative order.
  const importedTitles = targetCards.filter((c) => c.boardId === result.board.id).map((c) => c.title);
  assert.deepEqual(importedTitles, ["Exported first", "Exported second"]);
  const importedPositions = targetCards.filter((c) => c.boardId === result.board.id).map((c) => Number(c.position));
  assert.ok(importedPositions.every((p) => p > Number(existingCard.position)));
  assert.equal(new Set(targetCards.map((c) => c.position)).size, targetCards.length);
});
