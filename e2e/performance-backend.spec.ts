import type { APIRequestContext, APIResponse, Page } from "@playwright/test";
import { users, webOrigin } from "./support/env";
import { expect, test } from "./support/scenario";
import { boardIdOf, expectBoardLoaded, openCard } from "./support/ui";

type Card = { id: string; title: string; key: string; organisationKey: string };

async function result<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

async function createBoard(page: Page, api: APIRequestContext, name: string) {
  const existing = await boardIdOf(page, "E2E primary board");
  const context = await result<{ board: { workspaceId: string }; lists: { id: string }[] }>(await api.get(`/api/boards/${existing}?includeCards=false`));
  const board = await result<{ id: string }>(await api.post(`/api/workspaces/${context.board.workspaceId}/boards`, { data: { name } }));
  return { ...board, workspaceId: context.board.workspaceId, listId: context.lists[0]!.id };
}

test("linked-item batching preserves assigned-only guests, personal notes and immediate revocation", async ({ page, signIn, apiAs, pageAs, uniqueName }, testInfo) => {
  await signIn(page, "amelia");
  const owner = await apiAs("amelia");
  const guest = await apiAs("maya");
  const maya = await result<{ id: string }>(await guest.get("/api/me"));
  const boardName = uniqueName("Restricted links");
  const board = await createBoard(page, owner, boardName);
  await result(await owner.post(`/api/workspaces/${board.workspaceId}/guests/invitations`, { data: { boardId: board.id, email: users.maya.email, role: "editor", assignedItemsOnly: true } }));
  const createCard = (title: string, assigned: boolean) => owner.post(`/api/boards/${board.id}/lists/${board.listId}/cards`, { data: { title: uniqueName(title), assigneeIds: assigned ? [maya.id] : [] } }).then(result<Card>);
  const source = await createCard("Linked source", true);
  const visible = await createCard("Visible linked card", true);
  const checklistOnly = await createCard("Checklist linked card", false);
  const hidden = await createCard("Hidden linked card", false);
  await result(await owner.post(`/api/cards/${checklistOnly.id}/checklists`, { data: { title: "Guest ownership", items: [{ text: "Guest item", assigneeId: maya.id }] } }));
  const teamNote = await result<{ id: string; title: string }>(await owner.post(`/api/boards/${board.id}/notes`, { data: { scope: "team", title: uniqueName("Team link note") } }));
  const privateNote = await result<{ id: string; title: string }>(await owner.post(`/api/boards/${board.id}/notes`, { data: { scope: "personal", title: uniqueName("Private link note") } }));
  const urls = [visible, checklistOnly, hidden].map((card) => `${webOrigin}/o/${card.organisationKey}/c/${card.key}`);
  urls.push(...[teamNote, privateNote].map((note) => `${webOrigin}/b/${board.id}?view=notes&noteId=${note.id}`));
  await result(await owner.patch(`/api/cards/${source.id}`, { data: { description: urls.join("\n\n") } }));
  // Confirm all five links exist and let the source owner trigger legacy link repair first. A
  // guest-triggered repair can prune inaccessible targets, masking a broken read-access filter.
  const ownerLinked = await result<{ linkedNotes: { id: string }[] }>(await owner.get(`/api/cards/${source.id}/detail`));
  expect(ownerLinked.linkedNotes.map((row) => row.id).sort()).toEqual([visible.id, checklistOnly.id, hidden.id, teamNote.id, privateNote.id].sort());
  const linked = await result<{ linkedNotes: { id: string }[] }>(await guest.get(`/api/cards/${source.id}/detail`));
  expect(linked.linkedNotes.map((row) => row.id).sort()).toEqual([visible.id, checklistOnly.id, teamNote.id].sort());
  const viewer = await pageAs("maya");
  await viewer.goto(`/b/${board.id}`);
  await expectBoardLoaded(viewer, boardName);
  const dialog = await openCard(viewer, source.title);
  const linkedItems = dialog.locator(".linked-note-item");
  await expect(linkedItems).toHaveCount(3);
  // A count alone could pass with one allowed card replaced by one forbidden card. Check exactly
  // the assigned card, checklist-only card and team note, and their actual navigation targets.
  for (const card of [visible, checklistOnly]) {
    await expect(linkedItems.filter({ hasText: card.title })).toHaveAttribute("href", `/o/${card.organisationKey}/c/${card.key}`);
  }
  const teamNoteLink = linkedItems.filter({ hasText: teamNote.title });
  await expect(teamNoteLink).toHaveAttribute("href", /\S/);
  const teamNoteUrl = new URL((await teamNoteLink.getAttribute("href"))!, webOrigin);
  expect(teamNoteUrl.pathname).toBe(`/b/${board.id}`);
  expect(teamNoteUrl.searchParams.get("view")).toBe("notes");
  expect(teamNoteUrl.searchParams.get("noteId")).toBe(teamNote.id);
  await expect(linkedItems.filter({ hasText: hidden.title })).toHaveCount(0);
  await expect(linkedItems.filter({ hasText: privateNote.title })).toHaveCount(0);
  await viewer.screenshot({ path: testInfo.outputPath("restricted-linked-items.png") });
  await result(await owner.patch(`/api/boards/${board.id}/members/${maya.id}`, { data: { role: "editor", assignedItemsOnly: false } }));
  const expanded = await result<{ linkedNotes: { id: string }[] }>(await guest.get(`/api/cards/${source.id}/detail`));
  expect(expanded.linkedNotes.map((row) => row.id).sort()).toEqual([visible.id, checklistOnly.id, hidden.id, teamNote.id].sort());
  expect((await owner.delete(`/api/workspaces/${board.workspaceId}/guests/${board.id}/${maya.id}`)).status()).toBe(200);
  expect((await guest.get(`/api/cards/${source.id}/detail`)).status()).toBe(403);
  await testInfo.attach("linked-permission-boundaries.json", { body: JSON.stringify({ source, ownerLinked, linked, expanded }, null, 2), contentType: "application/json" });
});

test("Global Work inactivity includes child-entity activity", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  await signIn(page, "amelia");
  const api = await apiAs("amelia");
  const board = await createBoard(page, api, uniqueName("Inactivity comments"));
  const makeCard = (title: string) => api.post(`/api/boards/${board.id}/lists/${board.listId}/cards`, { data: { title: uniqueName(title) } }).then(result<Card>);
  const active = await makeCard("Comment activity");
  const quiet = await makeCard("Quiet activity");
  const cutoff = new Date(Date.now() + 10).toISOString();
  await expect.poll(() => Date.now()).toBeGreaterThan(Date.parse(cutoff));
  const comment = await result<{ id: string }>(await api.post(`/api/cards/${active.id}/comments`, { data: { body: "A new comment counts as card activity." } }));
  // Unlike inactiveOnly (the card's updatedAt clock), lastActivityBefore reads audit entities.
  // A direct-card-only optimization would lose this comment's payload.cardId and include active.
  const query = await result<{ cards: { id: string }[]; totals: { cards: number } }>(await api.post("/api/work/cards/query", { data: { lens: "portfolio", scope: { allAccessible: false, boardIds: [board.id] }, filters: { lastActivityBefore: cutoff, completion: "all" } } }));
  expect(query.cards.map((card) => card.id)).toEqual([quiet.id]);
  expect(query.totals.cards).toBe(1);
  await testInfo.attach("indexed-activity-results.json", { body: JSON.stringify({ cutoff, active, quiet, comment, query }, null, 2), contentType: "application/json" });
});
