import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { expectBoardLoaded } from "./support/ui";

// In-progress lists and time in progress. The test owns its workspace, because flagging a list is a
// shared, workspace-wide change. Two pages for one user are two sockets, so every assertion on the
// board page after the first load is realtime delivery, not a reload.

type Workspace = { workspaceId: string; boardId: string; lists: Map<string, string> };

async function createWorkspace(api: APIRequestContext, name: string, boardName: string): Promise<Workspace> {
  const created = await api.post("/api/workspaces", {
    data: {
      name,
      lists: [{ name: "Todo", icon: "circle" }, { name: "Doing", icon: "progress" }, { name: "Done", icon: "circle-check" }],
      customFields: [],
      labels: [],
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = ((await created.json()) as { id: string }).id;
  const board = await api.post(`/api/workspaces/${workspaceId}/boards`, { data: { name: boardName } });
  expect(board.ok(), await board.text()).toBe(true);
  const boardId = ((await board.json()) as { id: string }).id;
  const detail = await api.get(`/api/boards/${boardId}?includeCards=false`);
  const { lists } = (await detail.json()) as { lists: { id: string; name: string; inProgress: boolean }[] };
  // Explicit lists arrive unflagged unless the request marks them.
  expect(lists.every((list) => !list.inProgress)).toBe(true);
  return { workspaceId, boardId, lists: new Map(lists.map((list) => [list.name, list.id])) };
}

async function createCard(api: APIRequestContext, ws: Workspace, list: string, title: string): Promise<string> {
  const created = await api.post(`/api/boards/${ws.boardId}/lists/${ws.lists.get(list)}/cards`, { data: { title } });
  expect(created.ok(), await created.text()).toBe(true);
  return ((await created.json()) as { id: string }).id;
}

async function moveCard(api: APIRequestContext, ws: Workspace, cardId: string, list: string) {
  const moved = await api.post(`/api/cards/${cardId}/move`, { data: { listId: ws.lists.get(list), afterCardId: null } });
  expect(moved.ok(), await moved.text()).toBe(true);
}

function tile(page: Page, title: string): Locator {
  return page.locator("k-card").filter({ hasText: title });
}

function listHeader(page: Page, name: string): Locator {
  return page.locator("k-list").filter({ has: page.locator(".list-header h3", { hasText: name }) });
}

test("marking a list in progress shows time in progress live on tiles, table and card detail", async ({ page, signIn, pageAs, apiAs, uniqueName }) => {
  const api = await apiAs("amelia");
  const boardName = uniqueName("E2E Time Board");
  const ws = await createWorkspace(api, uniqueName("E2E Time Workspace"), boardName);
  const earlier = uniqueName("E2E moved before flagging");
  const later = uniqueName("E2E moved after flagging");
  const finished = uniqueName("E2E finished before entering");
  const earlierId = await createCard(api, ws, "Todo", earlier);
  const laterId = await createCard(api, ws, "Todo", later);
  const finishedId = await createCard(api, ws, "Todo", finished);
  const completed = await api.patch(`/api/cards/${finishedId}/completion`, { data: { completed: true } });
  expect(completed.ok(), await completed.text()).toBe(true);
  // Moved into "Doing" while it is still an ordinary list: flagging must date this from history.
  await moveCard(api, ws, earlierId, "Doing");

  await signIn(page, "amelia");
  await page.goto(`/b/${ws.boardId}`);
  await expectBoardLoaded(page, boardName);
  await expect(tile(page, earlier)).toHaveCount(1);
  await expect(tile(page, earlier).locator(".card-time-in-progress")).toHaveCount(0);
  await expect(listHeader(page, "Doing").locator(".list-in-progress")).toHaveCount(0);

  // An admin flags "Doing" from workspace settings, in another tab.
  const settings = await pageAs("amelia");
  await settings.goto(`/w/${ws.workspaceId}/settings/lists`);
  await settings.getByRole("button", { name: "Mark Doing as in progress", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Unmark Doing as in progress", exact: true })).toHaveAttribute("aria-pressed", "true");
  await settings.screenshot({ path: test.info().outputPath("settings-lists.png") });

  // The open board picks up the flag and the back-filled start without a reload.
  await expect(listHeader(page, "Doing").locator(".list-in-progress")).toHaveCount(1);
  // The column explains what the flag means until someone dismisses it; plain lists never show it.
  await expect(listHeader(page, "Doing").locator(".list-in-progress-hint")).toContainText("Work here is actively happening");
  await expect(page.locator(".list-in-progress-hint")).toHaveCount(1);
  await expect(tile(page, earlier).locator(".card-time-in-progress")).toHaveText(/^\s*(<1|\d+)m\s*$/);
  await expect(tile(page, later).locator(".card-time-in-progress")).toHaveCount(0);

  // Entering starts the clock, leaving stops it: both as realtime moves. A stopped total stays on the
  // card (time-tracking.spec.ts), but one under a minute, like this stint, is not shown.
  await moveCard(api, ws, laterId, "Doing");
  await expect(tile(page, later).locator(".card-time-in-progress")).toBeVisible();
  await moveCard(api, ws, earlierId, "Done");
  await expect(tile(page, earlier).locator(".card-time-in-progress")).toHaveCount(0);
  // Finished work placed into an in-progress list: the clock only runs for open work, so there is
  // no measured time to show (not a made-up "1m").
  await moveCard(api, ws, finishedId, "Doing");
  await expect(listHeader(page, "Doing").locator("k-card").filter({ hasText: finished })).toHaveCount(1);
  await expect(tile(page, finished).locator(".card-time-in-progress")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("board-time-in-progress.png") });
  await page.getByRole("button", { name: "Dismiss in-progress explanation" }).click();
  await expect(page.locator(".list-in-progress-hint")).toHaveCount(0);

  // Card detail shows it above the description.
  await tile(page, later).click();
  const detail = page.getByRole("dialog", { name: `Card detail: ${later}` });
  await expect(detail.locator(".col-main .detail-time-in-progress")).toContainText("In progress");
  await page.screenshot({ path: test.info().outputPath("card-detail.png") });
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();

  // The table's Time in progress column is on by default.
  await page.getByRole("button", { name: "Table view" }).click();
  const table = page.locator("k-board-table-view");
  await expect(table).toContainText("Time in progress");
  await expect(table.locator(`.tv-row[data-card-id="${laterId}"] [data-col="inProgress"] .tv-time-in-progress`)).toBeVisible();
  await expect(table.locator(`.tv-row[data-card-id="${earlierId}"] [data-col="inProgress"] .tv-time-in-progress`)).toHaveCount(0);

  // Converged with the server after a reload; the dismissed explanation stays dismissed.
  await page.reload();
  await expect(table.locator(`.tv-row[data-card-id="${laterId}"] [data-col="inProgress"] .tv-time-in-progress`)).toBeVisible();

  // Unflagging clears every clock in the list, live.
  await page.getByRole("button", { name: "Board view" }).click();
  await expect(tile(page, later).locator(".card-time-in-progress")).toBeVisible();
  await expect(page.locator(".list-in-progress-hint")).toHaveCount(0);
  await settings.getByRole("button", { name: "Unmark Doing as in progress", exact: true }).click();
  await expect(tile(page, later).locator(".card-time-in-progress")).toHaveCount(0);
  await expect(listHeader(page, "Doing").locator(".list-in-progress")).toHaveCount(0);
});
