import type { APIRequestContext, APIResponse, Page } from "@playwright/test";
import { users } from "./support/env";
import { expect, test } from "./support/fixtures";
import { boardIdOf, expectBoardLoaded, moveCardToBoard, openCard } from "./support/ui";

type WireCard = { id: string; title: string; listId: string; position: string; completedAt: string | null };
type WireCardDetail = {
  card: WireCard;
  checklists: { items: { id: string; text: string; description: string | null; assigneeId: string | null; completedAt: string | null }[] }[];
};

async function result<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

async function workspace(page: Page, api: APIRequestContext) {
  const boardId = await boardIdOf(page, "Platform Delivery");
  return result<{ board: { workspaceId: string }; lists: { id: string; name: string }[] }>(
    await api.get(`/api/boards/${boardId}?includeCards=false`),
  );
}

test("concurrent refreshes rotate one cookie only once and keep the browser signed in", async ({ page, signIn }, testInfo) => {
  await signIn(page, "amelia");
  const cookie = (await page.context().cookies()).find((entry) => entry.name === "kanera_rt");
  expect(cookie).toBeDefined();
  // Pin every request to the original cookie, as tabs do when they wake at the same time.
  const responses = await Promise.all(Array.from({ length: 12 }, () => page.request.post("/api/auth/refresh", {
    headers: { cookie: `kanera_rt=${cookie!.value}` }, data: {},
  })));
  const evidence = responses.map((response) => ({
    status: response.status(), rotated: response.headersArray().some((header) => header.name.toLowerCase() === "set-cookie"),
  }));
  await testInfo.attach("refresh-race.json", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
  expect(evidence.map((entry) => entry.status)).toEqual(Array<number>(12).fill(200));
  expect(evidence.filter((entry) => entry.rotated)).toHaveLength(1);
  await page.reload();
  await expect(page.locator("k-app-shell")).toBeVisible();
});

test("board transfers clear ineligible checklist-only assignees and retain eligible ones", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  await signIn(page, "amelia");
  const api = await apiAs("amelia");
  const { board, lists } = await workspace(page, api);
  const sourceName = uniqueName("Assignment source");
  const targetName = uniqueName("Assignment target");
  const source = await result<{ id: string }>(await api.post(`/api/workspaces/${board.workspaceId}/boards`, { data: { name: sourceName } }));
  const target = await result<{ id: string }>(await api.post(`/api/workspaces/${board.workspaceId}/boards`, { data: { name: targetName } }));
  await result(await api.post(`/api/workspaces/${board.workspaceId}/guests/invitations`, {
    data: { boardId: source.id, email: users.maya.email, role: "editor" },
  }));
  const maya = await result<{ id: string }>(await (await apiAs("maya")).get("/api/me"));
  const amelia = await result<{ id: string }>(await api.get("/api/me"));
  const title = uniqueName("Checklist transfer");
  const card = await result<WireCard>(await api.post(`/api/boards/${source.id}/lists/${lists[0]!.id}/cards`, { data: { title, assigneeIds: [] } }));
  await result(await api.post(`/api/cards/${card.id}/checklists`, { data: {
    title: "Ownership", items: [{ text: "Guest task", assigneeId: maya.id }, { text: "Owner task", assigneeId: amelia.id }],
  } }));
  const before = await result<WireCardDetail>(await api.get(`/api/cards/${card.id}/detail`));
  expect(before.checklists[0]!.items.map((item) => item.assigneeId)).toEqual([maya.id, amelia.id]);
  await page.goto(`/b/${source.id}`);
  await expectBoardLoaded(page, sourceName);
  await moveCardToBoard(await openCard(page, title), targetName);
  await page.goto(`/b/${target.id}`);
  await expectBoardLoaded(page, targetName);
  const detail = await openCard(page, title);
  const after = await result<WireCardDetail>(await api.get(`/api/cards/${card.id}/detail`));
  await testInfo.attach("transferred-checklists.json", { body: JSON.stringify(after.checklists, null, 2), contentType: "application/json" });
  expect(after.checklists[0]!.items.map((item) => item.assigneeId)).toEqual([null, amelia.id]);
  await expect(detail.locator(".checklist-item").filter({ hasText: "Guest task" }).locator(".checklist-item-assignee")).toHaveCount(0);
  await expect(detail.locator(".checklist-item").filter({ hasText: "Owner task" }).locator(".checklist-item-assignee")).toBeVisible();
});

test("board transfers drop inaccessible watchers but preserve destination observers", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  await signIn(page, "amelia");
  const api = await apiAs("amelia");
  const guest = await apiAs("maya");
  const maya = await result<{ id: string }>(await guest.get("/api/me"));
  const amelia = await result<{ id: string }>(await api.get("/api/me"));
  const { board, lists } = await workspace(page, api);
  const createBoard = (name: string) => api.post(`/api/workspaces/${board.workspaceId}/boards`, { data: { name: uniqueName(name) } }).then(result<{ id: string }>);
  const source = await createBoard("Watch source");
  const privateBoard = await createBoard("Private target");
  const observerBoard = await createBoard("Observer target");
  for (const boardId of [source.id, observerBoard.id]) {
    await result(await api.post(`/api/workspaces/${board.workspaceId}/guests/invitations`, {
      data: { boardId, email: users.maya.email, role: "observer" },
    }));
  }
  const evidence: unknown[] = [];
  // A watching observer can read without being eligible for assignment. Assigned-only observers
  // lose visibility on an unassigned card, even though their destination board membership remains.
  for (const [target, retained, restricted] of [[privateBoard, false, false], [observerBoard, true, false], [observerBoard, false, true]] as const) {
    if (restricted) await result(await api.patch(`/api/boards/${observerBoard.id}/members/${maya.id}`, { data: { role: "observer", assignedItemsOnly: true } }));
    const card = await result<WireCard>(await api.post(`/api/boards/${source.id}/lists/${lists[0]!.id}/cards`, { data: { title: uniqueName("Watched transfer"), assigneeIds: [] } }));
    expect((await guest.put(`/api/cards/${card.id}/watch`)).status()).toBe(204);
    expect((await api.put(`/api/cards/${card.id}/watch`)).status()).toBe(204);
    await result(await api.post(`/api/cards/${card.id}/move-to-board`, { data: { boardId: target.id } }));
    const watchers = await result<{ userId: string }[]>(await api.get(`/api/cards/${card.id}/watchers`));
    evidence.push({ cardId: card.id, targetBoardId: target.id, retained, restricted, watchers });
    expect(watchers.map((watcher) => watcher.userId).sort()).toEqual((retained ? [amelia.id, maya.id] : [amelia.id]).sort());
    expect((await guest.get(`/api/cards/${card.id}/detail`)).status()).toBe(retained ? 200 : 403);
  }
  await testInfo.attach("transferred-watchers.json", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
});

test("bulk and cross-board moves return the final card after list automations", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  await signIn(page, "amelia");
  const api = await apiAs("amelia");
  const { board, lists } = await workspace(page, api);
  const sourceName = uniqueName("Automation source");
  const source = await result<{ id: string }>(await api.post(`/api/workspaces/${board.workspaceId}/boards`, { data: { name: sourceName } }));
  const target = await result<{ id: string }>(await api.post(`/api/workspaces/${board.workspaceId}/boards`, { data: { name: uniqueName("Automation target") } }));
  const trigger = await result<{ id: string }>(await api.post(`/api/workspaces/${board.workspaceId}/lists`, { data: { name: uniqueName("Automation trigger") } }));
  const destination = await result<{ id: string }>(await api.post(`/api/workspaces/${board.workspaceId}/lists`, { data: { name: uniqueName("Automation destination") } }));
  await result(await api.post(`/api/workspaces/${board.workspaceId}/automations`, { data: {
    enabled: true, triggerType: "card_enters_list", triggerListId: trigger.id, applyOnCreate: false,
    actions: [{ type: "set_completion", config: { completed: true } }, { type: "move_to_list", config: { listId: destination.id } }],
  } }));
  const create = (title: string) => api.post(`/api/boards/${source.id}/lists/${lists[0]!.id}/cards`, { data: { title } }).then(result<WireCard>);
  const bulkCard = await create(uniqueName("Bulk automation"));
  const transferredCard = await create(uniqueName("Transfer automation"));
  await page.goto(`/b/${source.id}`);
  await expectBoardLoaded(page, sourceName);
  const bulk = await result<{ cards: WireCard[] }>(await api.post(`/api/boards/${source.id}/cards/bulk/move`, { data: { cardIds: [bulkCard.id], listId: trigger.id } }));
  const transferred = await result<WireCard>(await api.post(`/api/cards/${transferredCard.id}/move-to-board`, { data: { boardId: target.id, listId: trigger.id } }));
  const persisted = await Promise.all([bulkCard, transferredCard].map((card) => api.get(`/api/cards/${card.id}/detail`).then(result<WireCardDetail>)));
  await testInfo.attach("automation-responses.json", { body: JSON.stringify({ bulk, transferred, persisted: persisted.map((detail) => detail.card) }, null, 2), contentType: "application/json" });
  for (const [index, card] of [bulk.cards[0]!, transferred].entries()) {
    expect(card.listId).toBe(destination.id);
    expect(card.completedAt).not.toBeNull();
    expect(card).toMatchObject({ listId: persisted[index]!.card.listId, position: persisted[index]!.card.position, completedAt: persisted[index]!.card.completedAt });
  }
  // Extra workspace lists can be outside the horizontally virtualized board viewport. The table
  // exposes the final status without depending on which lanes happen to be mounted.
  await page.getByRole("button", { name: "Table view" }).click();
  const row = page.locator(`k-board-table-view .tv-row[data-card-id="${bulkCard.id}"]`);
  await expect(row.locator('[data-col="status"]')).toContainText("Automation destination");
  await expect(row).toHaveClass(/is-completed/);
});

test("deleting a workspace list removes its cards from open board and Portfolio tables", async ({ page, signIn, pageAs, apiAs, uniqueName }) => {
  await signIn(page, "amelia");
  const api = await apiAs("amelia");
  const { board } = await workspace(page, api);
  const name = uniqueName("Deleted list board");
  const source = await result<{ id: string }>(await api.post(`/api/workspaces/${board.workspaceId}/boards`, { data: { name } }));
  const list = await result<{ id: string }>(await api.post(`/api/workspaces/${board.workspaceId}/lists`, { data: { name: uniqueName("Deleted list") } }));
  const title = uniqueName("Deleted list card");
  const card = await result<WireCard>(await api.post(`/api/boards/${source.id}/lists/${list.id}/cards`, { data: { title } }));
  await page.goto(`/b/${source.id}`);
  await expectBoardLoaded(page, name);
  await page.getByRole("button", { name: "Table view" }).click();
  const row = page.locator(`k-board-table-view .tv-row[data-card-id="${card.id}"]`);
  await expect(row).toBeVisible();
  const portfolio = await pageAs("marcus");
  await portfolio.goto("/portfolio");
  await portfolio.getByRole("button", { name: "Table view" }).click();
  await portfolio.getByRole("searchbox", { name: "Search cards" }).fill(title);
  const portfolioRow = portfolio.locator(`k-board-table-view .tv-row[data-card-id="${card.id}"]`);
  await expect(portfolioRow).toBeVisible();
  const deleted = await api.delete(`/api/lists/${list.id}`);
  expect(deleted.status(), await deleted.text()).toBe(204);
  await expect(row).toHaveCount(0);
  await expect(portfolioRow).toHaveCount(0);
  await page.reload();
  await expectBoardLoaded(page, name);
  await expect(row).toHaveCount(0);
});

test("concurrent checklist edits preserve changes to different fields", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  await signIn(page, "amelia");
  const api = await apiAs("amelia");
  const { lists } = await workspace(page, api);
  const boardId = await boardIdOf(page, "Platform Delivery");
  const title = uniqueName("Concurrent checklist");
  const card = await result<WireCard>(await api.post(`/api/boards/${boardId}/lists/${lists[0]!.id}/cards`, { data: { title } }));
  await result(await api.post(`/api/cards/${card.id}/checklists`, { data: { title: "Concurrent edits", items: [{ text: "Original" }] } }));
  const before = await result<WireCardDetail>(await api.get(`/api/cards/${card.id}/detail`));
  const itemId = before.checklists[0]!.items[0]!.id;
  const responses = await Promise.all([
    { text: "Renamed concurrently" }, { description: "Independent description" }, { completed: true },
  ].map((data) => api.patch(`/api/cards/${card.id}/checklist-items/${itemId}`, { data }).then(result)));
  const after = await result<WireCardDetail>(await api.get(`/api/cards/${card.id}/detail`));
  await testInfo.attach("checklist-race.json", { body: JSON.stringify({ responses, after: after.checklists }, null, 2), contentType: "application/json" });
  expect(after.checklists[0]!.items[0]).toMatchObject({ text: "Renamed concurrently", description: "Independent description" });
  expect(after.checklists[0]!.items[0]!.completedAt).not.toBeNull();
  await page.goto(`/b/${boardId}`);
  await expectBoardLoaded(page, "Platform Delivery");
  const detail = await openCard(page, title);
  await expect(detail.locator(".checklist-item-text").filter({ hasText: "Renamed concurrently" })).toHaveClass(/is-done/);
});

test("agent runs respect assigned-only visibility and the card's current board", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  await signIn(page, "amelia");
  const api = await apiAs("amelia");
  const guest = await apiAs("maya");
  const maya = await result<{ id: string }>(await guest.get("/api/me"));
  const { board, lists } = await workspace(page, api);
  const source = await result<{ id: string }>(await api.post(`/api/workspaces/${board.workspaceId}/boards`, { data: { name: uniqueName("Run source") } }));
  const target = await result<{ id: string }>(await api.post(`/api/workspaces/${board.workspaceId}/boards`, { data: { name: uniqueName("Run target") } }));
  await result(await api.post(`/api/workspaces/${board.workspaceId}/guests/invitations`, {
    data: { boardId: source.id, email: users.maya.email, role: "editor", assignedItemsOnly: true },
  }));
  const visible = await result<WireCard>(await api.post(`/api/boards/${source.id}/lists/${lists[0]!.id}/cards`, { data: { title: uniqueName("Visible run card"), assigneeIds: [maya.id] } }));
  const hidden = await result<WireCard>(await api.post(`/api/boards/${source.id}/lists/${lists[0]!.id}/cards`, { data: { title: uniqueName("Hidden run card"), assigneeIds: [] } }));
  const visibleRun = await result<{ id: string }>(await api.post(`/api/cards/${visible.id}/agent-runs`, { data: { title: "Visible work" } }));
  await result(await api.post(`/api/cards/${hidden.id}/agent-runs`, { data: { title: "Confidential work", summary: "This card is not assigned to the guest" } }));
  const runs = await result<{ runs: { id: string }[] }>(await guest.get(`/api/boards/${source.id}/agent-runs`));
  await testInfo.attach("restricted-runs.json", { body: JSON.stringify(runs, null, 2), contentType: "application/json" });
  expect.soft(runs.runs.map((run) => run.id)).toEqual([visibleRun.id]);
  // Even an unrestricted source-board guest must lose access when the card moves to a private
  // destination. The run's historical boardId must not stand in for the card's current access.
  await result(await api.patch(`/api/boards/${source.id}/members/${maya.id}`, { data: { role: "editor", assignedItemsOnly: false } }));
  await result(await api.post(`/api/cards/${visible.id}/move-to-board`, { data: { boardId: target.id } }));
  const destinationRuns = await result<{ runs: { id: string; boardId: string }[] }>(await api.get(`/api/boards/${target.id}/agent-runs`));
  expect(destinationRuns.runs).toMatchObject([{ id: visibleRun.id, boardId: target.id }]);
  expect((await guest.get(`/api/agent-runs/${visibleRun.id}`)).status()).toBe(403);
  expect((await guest.patch(`/api/agent-runs/${visibleRun.id}`, { data: { summary: "Unauthorized edit" } })).status()).toBe(403);
});

test("concurrent agent heartbeats cannot reopen a finished run", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  await signIn(page, "amelia");
  const api = await apiAs("amelia");
  const { lists } = await workspace(page, api);
  const boardId = await boardIdOf(page, "Platform Delivery");
  const card = await result<WireCard>(await api.post(`/api/boards/${boardId}/lists/${lists[0]!.id}/cards`, { data: { title: uniqueName("Run race") } }));
  const run = await result<{ id: string }>(await api.post(`/api/cards/${card.id}/agent-runs`, { data: { title: "Finishing" } }));
  const responses = await Promise.all([{ status: "succeeded" }, ...Array.from({ length: 10 }, () => ({}))].map((data) => api.patch(`/api/agent-runs/${run.id}`, { data })));
  expect(responses[0]!.status()).toBe(200);
  for (const response of responses.slice(1)) expect([200, 409]).toContain(response.status());
  const final = await result<{ status: string; endedAt: string | null }>(await api.get(`/api/agent-runs/${run.id}`));
  await testInfo.attach("agent-heartbeat-race.json", { body: JSON.stringify({ statuses: responses.map((response) => response.status()), final }, null, 2), contentType: "application/json" });
  expect(final.status).toBe("succeeded");
  expect(final.endedAt).not.toBeNull();
});
