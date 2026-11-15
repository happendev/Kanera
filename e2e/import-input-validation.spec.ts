import type { APIRequestContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, test } from "./support/fixtures";

function sourceArchive(listId: string, authorId: string) {
  const cardId = randomUUID(), fieldId = randomUUID(), commentId = randomUUID();
  return {
    format: "kanera.board.export", version: 1, exportedAt: new Date().toISOString(),
    board: { id: randomUUID(), workspaceId: randomUUID(), name: "Imported source" },
    lists: [{ id: listId, name: "Todo", position: "1000" }], labels: [], members: [],
    cards: [{ id: cardId, listId, title: "Imported card", position: "1000", dueDateLocalDate: "2026-11-01", dueDateSlot: "anyTime", dueDateTimezone: "Europe/Dublin" }],
    customFields: [{ id: fieldId, name: "Imported select", type: "select", options: [
      { id: randomUUID(), label: "Explicit position", position: "42.125" },
      { id: randomUUID(), label: "Legacy default" },
    ] }],
    cardAssignees: [], cardLabelAssignments: [], cardCustomFieldValues: [], cardWatchers: [], attachments: [],
    checklists: [{ id: randomUUID(), cardId, title: "Imported checklist", position: "1000", items: [
      { id: randomUUID(), text: "Imported item", position: "1000", dueDateLocalDate: "2026-11-01", dueDateSlot: "anyTime", dueDateTimezone: "UTC" },
      { id: randomUUID(), text: "Legacy undated item", position: "2000", dueDateTimezone: null },
    ] }],
    comments: [{ id: commentId, cardId, authorId, body: "Imported comment", editedAt: "2026-11-01T12:30:00Z" }],
    commentReactions: [{ commentId, userId: authorId, reactionType: "thumbs_up" }],
  };
}

function analyze(api: APIRequestContext, workspaceId: string, archive: unknown) {
  return api.post(`/api/workspaces/${workspaceId}/imports/kanera-board/analyze`, {
    multipart: { file: { name: "review-regression.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(archive)) } },
  });
}

function commitBody(archive: ReturnType<typeof sourceArchive>, authorId: string, name: string) {
  return {
    board: { name }, lists: { [archive.lists[0]!.id]: { action: "map", targetListId: archive.lists[0]!.id } }, labels: {},
    customFields: { [archive.customFields[0]!.id]: { action: "create" } }, members: { [authorId]: authorId },
    options: { includeArchived: true, importComments: true, importCustomFields: true, attachmentCopyMode: "skip" },
  };
}

// Older ready plans can contain inputs accepted before validation was tightened. Only fixture
// setup uses SQL; both analysis rejection and commit rejection go through the real API processes.
function replaceStoredSource(importId: string, source: unknown) {
  expect(importId).toMatch(/^[0-9a-f-]{36}$/);
  const encoded = Buffer.from(JSON.stringify(source)).toString("base64");
  execFileSync("docker", ["compose", "-p", "kanera-e2e", "-f", path.join(__dirname, "../docker-compose.e2e.yml"), "exec", "-T", "postgres", "psql", "-U", "kanera_test", "-d", "kanera_test_e2e", "-v", "ON_ERROR_STOP=1", "-c",
    `update kanera_board_import set source=convert_from(decode('${encoded}', 'base64'), 'UTF8')::jsonb where id='${importId}'`,
  ], { encoding: "utf8", timeout: 10_000 });
}

test("archive scalars are rejected at analysis and legacy-plan commit without creating a board", async ({ apiAs, testWorkspace, uniqueName }) => {
  const api = await apiAs("amelia");
  const me = await (await api.get("/api/me")).json() as { id: string };
  const archive = sourceArchive(testWorkspace.lists.get("Backlog")!, me.id);
  const before: unknown = await (await api.get(`/api/workspaces/${testWorkspace.id}/boards`)).json();
  const invalid: Record<string, unknown>[] = [
    { cards: [{ ...archive.cards[0], dueDateTimezone: "Not/AZone" }] },
    { checklists: [{ ...archive.checklists[0], items: [{ ...archive.checklists[0]!.items[0], dueDateTimezone: "Not/AZone" }] }] },
    ...["not-a-number", "10000000000", { injected: true }].map((position) => ({ customFields: [{ ...archive.customFields[0], options: [{ ...archive.customFields[0]!.options[0], position }] }] })),
    { commentReactions: [{ ...archive.commentReactions[0], reactionType: "not-a-reaction" }] },
    { comments: [{ ...archive.comments[0], editedAt: "0000-01-01T00:00:00Z" }] },
  ];
  for (const change of invalid) {
    const malformed = { ...archive, ...change };
    const rejected = await analyze(api, testWorkspace.id, malformed);
    expect(rejected.status(), await rejected.text()).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: "VALIDATION" });

    const ready = await analyze(api, testWorkspace.id, archive);
    expect(ready.status(), await ready.text()).toBe(201);
    const { importId } = await ready.json() as { importId: string };
    replaceStoredSource(importId, malformed);
    const committed = await api.post(`/api/imports/kanera-board/${importId}/commit`, { data: commitBody(archive, me.id, uniqueName("Rejected import")) });
    expect(committed.status(), await committed.text()).toBe(400);
    expect(await committed.json()).toMatchObject({ code: "VALIDATION" });
  }
  expect(await (await api.get(`/api/workspaces/${testWorkspace.id}/boards`)).json()).toEqual(before);
  const query = await api.post("/api/work/cards/query", { data: { lens: "portfolio", filters: { overdueOnly: true } } });
  expect(query.status(), await query.text()).toBe(200);
});

test("valid archived timezones, option positions and reactions still round-trip", async ({ apiAs, testWorkspace, uniqueName }) => {
  const api = await apiAs("amelia");
  const me = await (await api.get("/api/me")).json() as { id: string };
  const archive = sourceArchive(testWorkspace.lists.get("Backlog")!, me.id);
  const ready = await analyze(api, testWorkspace.id, archive);
  expect(ready.status(), await ready.text()).toBe(201);
  const { importId } = await ready.json() as { importId: string };
  const committed = await api.post(`/api/imports/kanera-board/${importId}/commit`, { data: commitBody(archive, me.id, uniqueName("Valid import")) });
  expect(committed.status(), await committed.text()).toBe(200);
  const { createdBoardId } = await committed.json() as { createdBoardId: string };
  const exported = await api.get(`/api/boards/${createdBoardId}/export`);
  expect(exported.status()).toBe(200);
  const restored = await exported.json() as ReturnType<typeof sourceArchive>;
  expect(restored.cards[0]).toMatchObject({ dueDateTimezone: "Europe/Dublin", dueDateLocalDate: "2026-11-01" });
  expect(restored.checklists[0]!.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ text: "Imported item", dueDateTimezone: "UTC" }),
    expect.objectContaining({ text: "Legacy undated item", dueDateTimezone: null }),
  ]));
  const options = restored.customFields[0]!.options;
  expect(Number(options.find(option => option.label === "Explicit position")!.position)).toBe(42.125);
  expect(Number(options.find(option => option.label === "Legacy default")!.position)).toBeGreaterThan(0);
  expect(restored.commentReactions).toHaveLength(1);
  expect(restored.commentReactions[0]!.reactionType).toBe("thumbs_up");
  expect(restored.comments[0]!.editedAt).toBe("2026-11-01T12:30:00.000Z");
  const query = await api.post("/api/work/cards/query", { data: { lens: "portfolio", filters: { overdueOnly: true } } });
  expect(query.status(), await query.text()).toBe(200);
});
