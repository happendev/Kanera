import type { APIResponse } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { users } from "./support/env";
import { expect, test } from "./support/fixtures";

async function result<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

// A workspace member without a board grant must not leak through alternate board representations.
test("board-only guest export excludes unrelated workspace members", async ({ apiAs, testWorkspace }) => {
  const owner = await apiAs("amelia");
  const guest = await apiAs("maya");
  const priya = await result<{ id: string }>(await (await apiAs("priya")).get("/api/me"));
  await result(await owner.patch(`/api/workspaces/${testWorkspace.id}/members/${priya.id}`, { data: { role: "member" } }));
  expect((await owner.delete(`/api/boards/${testWorkspace.boardId}/members/${priya.id}`)).status()).toBe(204);
  await result(await owner.post(`/api/workspaces/${testWorkspace.id}/guests/invitations`, {
    data: { boardId: testWorkspace.boardId, email: users.maya.email, role: "editor" },
  }));
  expect((await guest.get(`/api/workspaces/${testWorkspace.id}/members`)).status()).toBe(403);
  const archive = await result<{ members: { email: string }[]; cards: unknown[] }>(await guest.get(`/api/boards/${testWorkspace.boardId}/export`));
  expect(archive.cards).toEqual([]);
  expect(archive.members.map((member) => member.email)).toContain(users.maya.email);
  expect(archive.members.map((member) => member.email)).not.toContain(users.priya.email);
});

test("media renewal checks current board access and guest storage ownership", async ({ apiAs, testWorkspace }) => {
  const owner = await apiAs("amelia");
  const member = await apiAs("priya");
  const guest = await apiAs("maya");
  const priya = await result<{ id: string }>(await member.get("/api/me"));
  await result(await owner.patch(`/api/workspaces/${testWorkspace.id}/members/${priya.id}`, { data: { role: "member" } }));
  await result(await owner.post(`/api/workspaces/${testWorkspace.id}/guests/invitations`, {
    data: { boardId: testWorkspace.boardId, email: users.maya.email, role: "editor" },
  }));
  const card = await result<{ id: string }>(await owner.post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")}/cards`, { data: { title: "Private attachment" } }));
  const upload = async (api: typeof owner) => result<{ url: string }>(await api.post(`/api/cards/${card.id}/attachments`, {
    multipart: { file: { name: "private.txt", mimeType: "text/plain", buffer: Buffer.from("private fixture content") } },
  }));
  const hostFile = await upload(owner);
  const guestFile = await upload(guest);
  const stale = (url: string) => `${new URL(url).pathname}?t=expired&e=1`;
  const renew = (api: typeof owner, url: string) => api.get("/api/media/resign", { params: { u: stale(url) } });
  expect((await renew(member, hostFile.url)).status()).toBe(200);
  expect((await renew(guest, guestFile.url)).status()).toBe(200);
  expect((await owner.delete(`/api/boards/${testWorkspace.boardId}/members/${priya.id}`)).status()).toBe(204);
  expect((await member.get(`/api/cards/${card.id}`)).ok()).toBe(false);
  expect((await renew(member, hostFile.url)).status()).toBe(404);
  expect((await renew(member, guestFile.url)).status()).toBe(404);
  // The host can renew a guest's upload, and the guest can renew a host upload.
  expect((await renew(owner, guestFile.url)).status()).toBe(200);
  expect((await renew(guest, hostFile.url)).status()).toBe(200);
  // Previously issued bearer capabilities retain their intended lifetime; only renewal is denied.
  expect((await member.get(hostFile.url)).status()).toBe(200);
});

test("media renewal preserves personal note and scratchpad privacy", async ({ apiAs, testWorkspace }) => {
  const owner = await apiAs("amelia");
  const otherAdmin = await apiAs("marcus");
  await result(await owner.patch(`/api/workspaces/${testWorkspace.id}`, { data: { notesEnabled: true } }));
  const note = await result<{ id: string }>(await owner.post(`/api/boards/${testWorkspace.boardId}/notes`, { data: { title: "Private note", scope: "personal" } }));
  const scratchpad = await result<{ id: string }>(await owner.post("/api/scratchpad/notes", { data: { title: "Private scratchpad" } }));
  for (const path of [`/api/notes/${note.id}/attachments`, `/api/scratchpad/notes/${scratchpad.id}/attachments`]) {
    const file = await result<{ url: string }>(await owner.post(path, {
      multipart: { file: { name: "private.txt", mimeType: "text/plain", buffer: Buffer.from("private fixture") } },
    }));
    const params = { u: `${new URL(file.url).pathname}?e=1&t=expired` };
    expect((await owner.get("/api/media/resign", { params })).status()).toBe(200);
    expect((await otherAdmin.get("/api/media/resign", { params })).status()).toBe(404);
  }
});

test("archive copies enforce private-file ownership while accessible expired attachments still import", async ({ apiAs, testWorkspace, uniqueName }) => {
  const owner = await apiAs("amelia");
  const importer = await apiAs("marcus");
  await result(await owner.patch(`/api/workspaces/${testWorkspace.id}`, { data: { notesEnabled: true } }));
  const card = await result<{ id: string }>(await owner.post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")}/cards`, { data: { title: "Archive attachment access" } }));
  const note = await result<{ id: string }>(await owner.post(`/api/boards/${testWorkspace.boardId}/notes`, { data: { title: "Private import source", scope: "personal" } }));
  const scratchpad = await result<{ id: string }>(await owner.post("/api/scratchpad/notes", { data: { title: "Private import source" } }));
  const attachmentSources = [
    { route: `/api/cards/${card.id}/attachments`, name: "accessible.txt", body: "accessible card bytes", allowed: true },
    { route: `/api/notes/${note.id}/attachments`, name: "personal-note.txt", body: "private note bytes", allowed: false },
    { route: `/api/scratchpad/notes/${scratchpad.id}/attachments`, name: "scratchpad.txt", body: "private scratchpad bytes", allowed: false },
  ];
  const attachments = [];
  for (const source of attachmentSources) {
    const file = await result<{ url: string }>(await owner.post(source.route, {
      multipart: { file: { name: source.name, mimeType: "text/plain", buffer: Buffer.from(source.body) } },
    }));
    // Restore must work after an export's capability expires, but only with current authority.
    const stale = new URL(file.url);
    stale.search = "?e=1&t=expired";
    expect((await importer.get("/api/media/resign", { params: { u: stale.toString() } })).status()).toBe(source.allowed ? 200 : 404);
    attachments.push({ id: randomUUID(), cardId: card.id, url: stale.toString(), mimeType: "text/plain", fileName: source.name });
  }
  const archive = await result<{ lists: { id: string }[] }>(await owner.get(`/api/boards/${testWorkspace.boardId}/export`));
  const analyzed = await result<{ importId: string }>(await importer.post(`/api/workspaces/${testWorkspace.id}/imports/kanera-board/analyze`, {
    multipart: { file: { name: "attachment-access.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...archive, attachments })) } },
  }));
  const imported = await result<{ createdBoardId: string; attachments: { imported: number; skipped: number }; warnings: string[] }>(await importer.post(`/api/imports/kanera-board/${analyzed.importId}/commit`, {
    data: {
      board: { name: uniqueName("Authorized attachment import") },
      lists: Object.fromEntries(archive.lists.map(list => [list.id, { action: "map", targetListId: list.id }])),
      labels: {}, customFields: {}, members: {},
      options: { includeArchived: true, importComments: false, importCustomFields: false, attachmentCopyMode: "copy" },
    },
  }));
  expect(imported.attachments).toEqual({ imported: 1, skipped: 2 });
  expect(imported.warnings).toHaveLength(2);
  const restored = await result<{ attachments: { fileName: string; url: string }[] }>(await importer.get(`/api/boards/${imported.createdBoardId}/export`));
  expect(restored.attachments.map(file => file.fileName)).toEqual(["accessible.txt"]);
  const copied = await importer.get(restored.attachments[0]!.url);
  expect(copied.status()).toBe(200);
  expect(await copied.text()).toBe("accessible card bytes");
});
