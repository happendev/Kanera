import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { boardHref, completeCard, expectBoardLoaded, moveCardToList, openBoard, openCard, renameCard, setDescription } from "./support/ui";

// One user edits a card through card detail; everyone else only has pages that were already open.
// Nothing here reloads, so every assertion on a viewer's page is realtime delivery into that view.

type BoardLists = { boardId: string; lists: Map<string, string> };

async function platformDelivery(page: Page, api: APIRequestContext): Promise<BoardLists> {
  const boardId = (await boardHref(page, "Platform Delivery")).split("/")[2]!;
  const response = await api.get(`/api/boards/${boardId}?includeCards=false`);
  const { lists } = (await response.json()) as { lists: { id: string; name: string }[] };
  return { boardId, lists: new Map(lists.map((list) => [list.name, list.id])) };
}

async function createCard(api: APIRequestContext, board: BoardLists, title: string, assigneeIds: string[] = []): Promise<string> {
  const created = await api.post(`/api/boards/${board.boardId}/lists/${board.lists.get("Backlog")}/cards`, { data: { title, assigneeIds } });
  expect(created.ok(), await created.text()).toBe(true);
  return ((await created.json()) as { id: string }).id;
}

async function userId(api: APIRequestContext): Promise<string> {
  const me = await api.get("/api/me");
  expect(me.ok(), await me.text()).toBe(true);
  const body = (await me.json()) as { id?: string; user?: { id: string } };
  return body.user?.id ?? body.id!;
}

/** The single open card-detail panel on a page, whatever the card is called right now. */
function openDetail(page: Page): Locator {
  return page.getByRole("dialog", { name: /^Card detail: / });
}

/** The list (lane) a card tile currently sits in, read from the lane header. */
function laneOf(page: Page, title: string): Locator {
  return page.locator("k-list").filter({ has: page.locator("k-card").filter({ hasText: title }) }).locator(".list-header h3");
}

function tableRow(page: Page, cardId: string): Locator {
  return page.locator(`k-board-table-view .tv-row[data-card-id="${cardId}"]`);
}

function workDoneRow(page: Page, title: string): Locator {
  return page.locator("li.wd-row").filter({ has: page.locator(".wd-card-title", { hasText: title }) });
}

async function showBoardView(page: Page, view: "Table view" | "Work done") {
  await page.getByRole("button", { name: view }).click();
  await expect(page.locator(view === "Table view" ? "k-board-table-view" : "k-work-done-view")).toBeVisible();
}

async function openGlobalWork(page: Page, path: "/my-cards" | "/team-cards" | "/portfolio", display: "Board view" | "Table view" | "Work done") {
  await page.goto(path);
  await page.getByRole("button", { name: display }).click();
  const ready = { "Board view": "section.workspace-board", "Table view": "k-board-table-view", "Work done": "k-work-done-view" }[display];
  await expect(page.locator(ready).first()).toBeVisible();
}

test("board detail, Kanban, table and work done follow another member's card edits live", async ({ page, signIn, pageAs, apiAs, uniqueName }) => {
  const title = uniqueName("E2E live edit");
  const renamed = `${title} renamed`;
  const description = uniqueName("E2E live description");
  await signIn(page, "amelia");
  const board = await platformDelivery(page, await apiAs("amelia"));
  const cardId = await createCard(await apiAs("amelia"), board, title);
  const inProgress = board.lists.get("In Progress")!;

  // Marcus watches the same card from three places: its open detail panel (over the Kanban), the
  // table view, and the Work done view.
  const detailPage = await pageAs("marcus");
  await openBoard(detailPage, "Platform Delivery");
  await openCard(detailPage, title);
  const tablePage = await pageAs("marcus");
  await openBoard(tablePage, "Platform Delivery");
  await showBoardView(tablePage, "Table view");
  await expect(tableRow(tablePage, cardId)).toBeVisible();
  const workDonePage = await pageAs("marcus");
  await openBoard(workDonePage, "Platform Delivery");
  await showBoardView(workDonePage, "Work done");
  await expect(workDoneRow(workDonePage, title)).toBeVisible();

  await openBoard(page, "Platform Delivery");
  const detail = await openCard(page, title);

  await renameCard(detail, renamed);
  await expect(openDetail(detailPage).locator("h2.card-title")).toHaveText(renamed);
  await expect(detailPage.locator("k-card").filter({ hasText: renamed })).toHaveCount(1);
  await expect(tableRow(tablePage, cardId).locator('[data-col="title"]')).toContainText(renamed);

  await setDescription(detail, description);
  await expect(openDetail(detailPage).locator(".description-viewer-wrap")).toContainText(description);

  await moveCardToList(detail, "In Progress");
  await expect(openDetail(detailPage).locator(".move-list-btn:visible").first()).toContainText("In Progress");
  await expect(detailPage.locator(`[id="dl-${inProgress}"] k-card`).filter({ hasText: renamed })).toHaveCount(1);
  await expect(tableRow(tablePage, cardId).locator('[data-col="status"]')).toContainText("In Progress");
  await expect(workDoneRow(workDonePage, renamed).locator(".wd-chip--moved, .wd-verb--moved").first()).toBeVisible();

  await completeCard(detail);
  await expect(openDetail(detailPage).getByRole("button", { name: "Mark incomplete" })).toBeVisible();
  await expect(detailPage.locator("k-card").filter({ hasText: renamed }).locator("a.card-link")).toHaveClass(/\bis-completed\b/);
  await expect(tableRow(tablePage, cardId)).toHaveClass(/\bis-completed\b/);
  await expect(workDoneRow(workDonePage, renamed).locator(".wd-verb--completed")).toBeVisible();

  // Nothing above reloaded; confirm the viewers converged on what the server stored.
  await tablePage.reload();
  await expectBoardLoaded(tablePage, "Platform Delivery");
  await expect(tableRow(tablePage, cardId)).toHaveClass(/\bis-completed\b/);
  await expect(tableRow(tablePage, cardId).locator('[data-col="status"]')).toContainText("In Progress");
});

test("Global Work lenses follow another user's card edits live", async ({ page, signIn, pageAs, apiAs, uniqueName }) => {
  const title = uniqueName("E2E global edit");
  const renamed = `${title} renamed`;
  await signIn(page, "amelia");
  const board = await platformDelivery(page, await apiAs("amelia"));
  const marcusId = await userId(await apiAs("marcus"));

  // Every viewer page is open before the card exists, so its arrival is live too. My Cards shows
  // cards assigned to the viewer (Marcus); Team Cards and Portfolio show them to a teammate (Priya).
  const myBoard = await pageAs("marcus");
  await openGlobalWork(myBoard, "/my-cards", "Board view");
  const myTable = await pageAs("marcus");
  await openGlobalWork(myTable, "/my-cards", "Table view");
  const teamBoard = await pageAs("priya");
  await openGlobalWork(teamBoard, "/team-cards", "Board view");
  // Work done is actor-scoped: My Cards lists what the viewer did, Team Cards what teammates did.
  // Amelia's edits therefore appear in Priya's Team Cards history, not in Marcus's My Cards one.
  const teamWorkDone = await pageAs("priya");
  await openGlobalWork(teamWorkDone, "/team-cards", "Work done");
  const portfolio = await pageAs("priya");
  await openGlobalWork(portfolio, "/portfolio", "Table view");
  // Search by the base title, which the renamed title still contains.
  await portfolio.getByRole("searchbox", { name: "Search cards" }).fill(title);

  const cardId = await createCard(await apiAs("amelia"), board, title, [marcusId]);

  await expect(laneOf(myBoard, title)).toContainText("Backlog");
  await expect(tableRow(myTable, cardId)).toBeVisible();
  await expect(workDoneRow(teamWorkDone, title)).toBeVisible();
  await expect(laneOf(teamBoard, title)).toContainText("Backlog");
  await expect(tableRow(portfolio, cardId)).toBeVisible();

  // Marcus also opens the card from My Cards: Global Work hosts card detail on its own state.
  const myDetailPage = await pageAs("marcus");
  await openGlobalWork(myDetailPage, "/my-cards", "Board view");
  await myDetailPage.locator("k-card").filter({ hasText: title }).click();
  await expect(openDetail(myDetailPage)).toBeVisible();

  await openBoard(page, "Platform Delivery");
  const detail = await openCard(page, title);

  await renameCard(detail, renamed);
  for (const viewer of [myBoard, teamBoard]) await expect(viewer.locator("k-card").filter({ hasText: renamed })).toHaveCount(1);
  for (const viewer of [myTable, portfolio]) await expect(tableRow(viewer, cardId).locator('[data-col="title"]')).toContainText(renamed);
  await expect(openDetail(myDetailPage).locator("h2.card-title")).toHaveText(renamed);

  await moveCardToList(detail, "In Progress");
  await expect(laneOf(myBoard, renamed)).toContainText("In Progress");
  await expect(laneOf(teamBoard, renamed)).toContainText("In Progress");
  for (const viewer of [myTable, portfolio]) await expect(tableRow(viewer, cardId).locator('[data-col="status"]')).toContainText("In Progress");
  await expect(openDetail(myDetailPage).locator(".move-list-btn:visible").first()).toContainText("In Progress");
  await expect(workDoneRow(teamWorkDone, renamed).locator(".wd-chip--moved, .wd-verb--moved").first()).toBeVisible();

  await completeCard(detail);
  for (const viewer of [myBoard, teamBoard]) {
    await expect(viewer.locator("k-card").filter({ hasText: renamed }).locator("a.card-link")).toHaveClass(/\bis-completed\b/);
  }
  for (const viewer of [myTable, portfolio]) await expect(tableRow(viewer, cardId)).toHaveClass(/\bis-completed\b/);
  await expect(openDetail(myDetailPage).getByRole("button", { name: "Mark incomplete" })).toBeVisible();
  await expect(workDoneRow(teamWorkDone, renamed).locator(".wd-verb--completed")).toBeVisible();

  // Unassigning removes the card from Marcus's lens but not from his teammate's Portfolio.
  const unassigned = await (await apiAs("amelia")).put(`/api/cards/${cardId}/assignees`, { data: { userIds: [] } });
  expect(unassigned.ok(), await unassigned.text()).toBe(true);
  await expect(myBoard.locator("k-card").filter({ hasText: renamed })).toHaveCount(0);
  await expect(tableRow(myTable, cardId)).toHaveCount(0);
  await expect(tableRow(portfolio, cardId)).toBeVisible();
});
