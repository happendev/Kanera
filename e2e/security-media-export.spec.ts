import type { APIResponse } from "@playwright/test";
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
