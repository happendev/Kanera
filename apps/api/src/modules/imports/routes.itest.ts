import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { CommitImportBody } from "@kanera/shared/dto";
import { activityEvents, boards, cardAttachments, cardChecklistItems, cardChecklists, cards, clients, comments, eventOutbox, kaneraBoardImports, lists, trelloImports } from "@kanera/shared/schema";
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

function jsonImportForm(value: unknown, fileName: string) {
  const form = new FormData();
  form.append("file", new Blob([JSON.stringify(value)], { type: "application/json" }), fileName);
  return form;
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

void test("standalone board settings can append Trello and Kanera imports into their sole board", async () => {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Standalone Imports", email: "standalone-imports@example.com", password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<SignupResponse>();
  const auth = { authorization: `Bearer ${accessToken}` };

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: auth,
    payload: {
      kind: "board",
      name: "Hidden configuration",
      initialBoard: { name: "Personal roadmap", icon: "rocket", iconColor: "violet" },
      lists: [{ name: "Todo" }, { name: "Done" }],
      customFields: [],
      labels: [],
    },
  });
  assert.equal(created.statusCode, 201);
  const standalone = created.json<{ id: string; initialBoard: { id: string; name: string; icon: string | null; iconColor: string | null } }>();
  const [targetList] = await db.select().from(lists).where(eq(lists.workspaceId, standalone.id)).limit(1);
  assert.ok(targetList);
  await db.insert(cards).values({
    listId: targetList.id,
    boardId: standalone.initialBoard.id,
    title: "Existing card",
    position: "1000.0000000000",
    createdById: user.id,
  });

  // Initial creation fanout is queued just after the HTTP response; wait for that baseline so an
  // import cannot accidentally pass by racing the original board:created outbox write.
  await waitForImportOutboxEvents(standalone.id, standalone.initialBoard.id, ["board:created"]);
  const boardCreatedOutboxBefore = await db.$count(eventOutbox, and(eq(eventOutbox.scopeId, standalone.initialBoard.id), eq(eventOutbox.eventType, "board:created")));
  const boardCreatedActivityBefore = await db.$count(activityEvents, and(eq(activityEvents.boardId, standalone.initialBoard.id), eq(activityEvents.entityType, "board"), eq(activityEvents.action, "created")));
  const trelloExport = {
    id: "trello-board",
    name: "Imported identity must be ignored",
    desc: "Imported description must be ignored",
    lists: [{ id: "trello-list", name: "Todo", closed: false, pos: 1000 }],
    labels: [],
    customFields: [],
    members: [],
    checklists: [],
    actions: [],
    cards: [{
      id: "trello-card",
      name: "Imported from Trello",
      desc: null,
      idList: "trello-list",
      pos: 1000,
      closed: false,
      due: null,
      dueComplete: false,
      idLabels: [],
      idMembers: [],
      idChecklists: [],
      customFieldItems: [],
      attachments: [],
    }],
  };
  const trelloAnalyzed = await app.inject({
    method: "POST",
    url: `/workspaces/${standalone.id}/imports/trello/analyze`,
    headers: auth,
    payload: jsonImportForm(trelloExport, "trello.json"),
  });
  assert.equal(trelloAnalyzed.statusCode, 201);
  const trelloImportId = trelloAnalyzed.json<{ importId: string }>().importId;
  const trelloCommitted = await app.inject({
    method: "POST",
    url: `/imports/${trelloImportId}/commit`,
    headers: auth,
    payload: {
      board: { name: "Replacement name", icon: "alien", iconColor: "red" },
      lists: { "trello-list": { action: "map", targetListId: targetList.id } },
      labels: {},
      customFields: {},
      members: {},
      options: { includeArchived: false, importComments: false, importCustomFields: false, attachmentCopyMode: "skip" },
    },
  });
  assert.equal(trelloCommitted.statusCode, 200);
  const trelloResult = trelloCommitted.json<ImportResult>();
  assert.equal(trelloResult.createdBoardId, standalone.initialBoard.id);
  assert.equal(trelloResult.cards.created, 1);

  // Importing a Kanera export of the same board exercises the second importer while proving that
  // the existing destination content is appended to, rather than cleared or moved to another board.
  const archive = await buildBoardExportArchive(standalone.initialBoard.id, user.clientId);
  const kaneraAnalyzed = await app.inject({
    method: "POST",
    url: `/workspaces/${standalone.id}/imports/kanera-board/analyze`,
    headers: auth,
    payload: jsonImportForm(archive, "kanera-board.json"),
  });
  assert.equal(kaneraAnalyzed.statusCode, 201);
  const analyzedKanera = kaneraAnalyzed.json<{ importId: string; manifest: { lists: { id: string }[]; members: { id: string }[] } }>();
  const kaneraCommitted = await app.inject({
    method: "POST",
    url: `/imports/kanera-board/${analyzedKanera.importId}/commit`,
    headers: auth,
    payload: {
      board: { name: "Another replacement name", icon: "alien", iconColor: "red" },
      lists: Object.fromEntries(analyzedKanera.manifest.lists.map((list) => [list.id, { action: "map", targetListId: list.id }])),
      labels: {},
      customFields: {},
      members: Object.fromEntries(analyzedKanera.manifest.members.map((member) => [member.id, user.id])),
      options: { includeArchived: true, importComments: true, importCustomFields: true, attachmentCopyMode: "skip" },
    },
  });
  assert.equal(kaneraCommitted.statusCode, 200);
  const kaneraResult = kaneraCommitted.json<ImportResult>();
  assert.equal(kaneraResult.createdBoardId, standalone.initialBoard.id);
  assert.ok(kaneraResult.cards.created >= 2);

  const [targetBoard] = await db.select().from(boards).where(eq(boards.id, standalone.initialBoard.id)).limit(1);
  assert.equal(await db.$count(boards, eq(boards.workspaceId, standalone.id)), 1);
  assert.equal(targetBoard?.name, "Personal roadmap");
  assert.equal(targetBoard?.icon, "rocket");
  assert.equal(targetBoard?.iconColor, "violet");
  assert.ok(await db.$count(cards, and(eq(cards.boardId, standalone.initialBoard.id), eq(cards.title, "Existing card"))) >= 2);
  assert.equal(await db.$count(eventOutbox, and(eq(eventOutbox.scopeId, standalone.initialBoard.id), eq(eventOutbox.eventType, "board:created"))), boardCreatedOutboxBefore);
  assert.equal(await db.$count(activityEvents, and(eq(activityEvents.boardId, standalone.initialBoard.id), eq(activityEvents.entityType, "board"), eq(activityEvents.action, "created"))), boardCreatedActivityBefore);
});

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
  assert.equal(result.attachments.skipped, 1);
  assert.ok(result.warnings.some((warning) => warning.includes("attachment links were preserved")));
  assert.ok(result.warnings.some((warning) => warning.includes("could not be copied because Trello was not connected")));
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

void test("POST /imports/:importId/commit copies Trello uploaded attachments when connected", async () => {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Trello Files Co",
      email: "owner-trello-files@example.com",
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

  const source: NormalizedTrelloBoard = {
    board: { id: "trello-board-files", name: "Trello Files", desc: null },
    lists: [{ id: "trello-list", name: "Todo", closed: false, pos: 1 }],
    labels: [],
    customFields: [],
    members: [],
    cards: [{
      id: "trello-card",
      name: "Copy file",
      desc: null,
      listId: "trello-list",
      pos: 1,
      closed: false,
      due: null,
      dueComplete: false,
      labelIds: [],
      memberIds: [],
      checklistIds: [],
      customFieldItems: [],
      coverAttachmentId: "trello-upload",
      attachments: [{
        id: "trello-upload",
        name: "image.png",
        url: "https://trello.com/1/cards/trello-card/attachments/trello-upload/download/image.png",
        isUpload: true,
        mimeType: "message/rfc822",
        byteSize: 5,
      }],
    }],
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
    manifest: { board: { name: source.board.name, desc: source.board.desc }, lists: [], labels: [], customFields: [], members: [], counts: { cards: 1, checklists: 0, comments: 0, linkAttachments: 0, uploadedAttachments: 1 } },
    source,
  });

  const previousKey = env.TRELLO_API_KEY;
  const previousFetch = globalThis.fetch;
  env.TRELLO_API_KEY = "trello-key";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(url.hostname, "api.trello.com");
    assert.equal(url.searchParams.get("key"), null);
    assert.equal(url.searchParams.get("token"), null);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), 'OAuth oauth_consumer_key="trello-key", oauth_token="trello-token"');
    return new Response("hello", { status: 200, headers: { "content-type": "message/rfc822", "content-disposition": 'attachment; filename="thread.eml"' } });
  }) as typeof fetch;
  try {
    const committed = await app.inject({
      method: "POST",
      url: `/imports/${importId}/commit`,
      headers: { authorization: `Bearer ${accessToken}`, "x-trello-token": "trello-token" },
      payload: {
        board: { name: "Imported Files" },
        lists: { "trello-list": { action: "create", name: "Todo" } },
        labels: {},
        customFields: {},
        members: {},
        options: { includeArchived: false, importComments: true, importCustomFields: true, attachmentCopyMode: "copy" },
      },
    });
    assert.equal(committed.statusCode, 200);
    const result = committed.json<ImportResult>();
    assert.equal(result.attachments.imported, 1);
    assert.equal(result.attachments.skipped, 0);

    const [card] = await db.select().from(cards).where(eq(cards.boardId, result.createdBoardId)).limit(1);
    assert.ok(card);
    const [attachment] = await db.select().from(cardAttachments).where(eq(cardAttachments.cardId, card.id)).limit(1);
    assert.ok(attachment);
    assert.equal(attachment.fileName, "thread.eml");
    assert.equal(attachment.mimeType, "message/rfc822");
    assert.equal(attachment.byteSize, 5);
    assert.equal(card.coverAttachmentId, attachment.id);
    const storage = await getStorageForClient(user.clientId);
    assert.equal((await storage.get(attachment.fileKey)).toString("utf8"), "hello");

    const outboxRows = await waitForImportOutboxEvents(workspace.id, result.createdBoardId, ["card:attachment:created", "card:updated"]);
    assert.ok(outboxRows.some((row) => row.eventType === "card:attachment:created"));
    assert.ok(outboxRows.some((row) => row.eventType === "card:updated"));

    const [importRow] = await db.select().from(trelloImports).where(eq(trelloImports.id, importId)).limit(1);
    assert.equal(JSON.stringify(importRow?.mappings).includes("trello-token"), false);
  } finally {
    env.TRELLO_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
  }
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

void test("Kanera board import round-trips nested checklist detail and item descriptions", async () => {
  const { user, workspace, targetList } = await setupImportTarget("Acme Kanera Detail", "owner-kanera-detail@example.com");

  // Source board with a top-level checklist item that carries a description and its own nested
  // (item-detail) checklist. Export + re-import must preserve the description and keep the nested
  // checklist parented to the *new* item id rather than flattening it to a top-level checklist.
  const [sourceBoard] = await db.insert(boards).values({ workspaceId: workspace.id, name: "Detail source", position: "9100.0000000000" }).returning();
  assert.ok(sourceBoard);
  const [sourceList] = await db.insert(lists).values({ workspaceId: workspace.id, name: "Detail list", position: "9100.0000000000" }).returning();
  assert.ok(sourceList);
  const [sourceCard] = await db.insert(cards).values({ listId: sourceList.id, boardId: sourceBoard.id, title: "Detailed card", position: "1000.0000000000", createdById: user.id }).returning();
  assert.ok(sourceCard);
  const [topChecklist] = await db.insert(cardChecklists).values({ cardId: sourceCard.id, title: "Top", position: "1000.0000000000" }).returning();
  assert.ok(topChecklist);
  const [parentItem] = await db.insert(cardChecklistItems).values({ checklistId: topChecklist.id, text: "Parent item", description: "**Detailed** notes", position: "1000.0000000000" }).returning();
  assert.ok(parentItem);
  const [nestedChecklist] = await db.insert(cardChecklists).values({ cardId: sourceCard.id, parentItemId: parentItem.id, title: "Sub steps", position: "1000.0000000000" }).returning();
  assert.ok(nestedChecklist);
  await db.insert(cardChecklistItems).values({ checklistId: nestedChecklist.id, text: "Sub item", position: "1000.0000000000" });

  const archive = await buildBoardExportArchive(sourceBoard.id, user.clientId);
  const exportedList = archive.lists.find((l) => l.id === sourceList.id);
  assert.ok(exportedList);
  // The exported archive must actually carry the new schema fields, or the round-trip is vacuous.
  const exportedNested = archive.checklists.find((c) => c.title === "Sub steps");
  assert.equal(exportedNested?.parentItemId, parentItem.id);
  const exportedParentItem = archive.checklists.find((c) => c.title === "Top")?.items.find((i) => i.text === "Parent item");
  assert.equal(exportedParentItem?.description, "**Detailed** notes");

  const body: CommitImportBody = {
    board: { name: "Imported detail" },
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

  const [importedCard] = await db.select().from(cards).where(and(eq(cards.boardId, result.board.id), eq(cards.title, "Detailed card"))).limit(1);
  assert.ok(importedCard);
  const importedChecklists = await db.select().from(cardChecklists).where(eq(cardChecklists.cardId, importedCard.id));
  const importedTop = importedChecklists.find((c) => c.title === "Top");
  const importedNested = importedChecklists.find((c) => c.title === "Sub steps");
  assert.ok(importedTop);
  assert.ok(importedNested);

  // Top-level checklist stays top-level; its item keeps the markdown description.
  assert.equal(importedTop.parentItemId, null);
  const importedItems = await db.select().from(cardChecklistItems).where(eq(cardChecklistItems.checklistId, importedTop.id));
  const importedParentItem = importedItems.find((i) => i.text === "Parent item");
  assert.ok(importedParentItem);
  assert.equal(importedParentItem.description, "**Detailed** notes");

  // Nested checklist is re-parented onto the freshly inserted item id, not flattened or dropped.
  assert.equal(importedNested.parentItemId, importedParentItem.id);
  const importedSubItems = await db.select().from(cardChecklistItems).where(eq(cardChecklistItems.checklistId, importedNested.id));
  assert.deepEqual(importedSubItems.map((i) => i.text), ["Sub item"]);
});
