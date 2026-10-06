import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { expectBoardLoaded } from "./support/ui";

// Time in progress as time tracking: a card's total across every stint, counting working hours only
// (09:00-17:00, Monday to Friday, in the workspace's zone), stays on it after it leaves progress or is
// completed, reads above the description in card detail, shows in Work done, and sums or averages in
// the table. The workspace works in UTC and the running stint is exactly two weeks old: any 14 x 24
// hours holds exactly 80 working hours, so the numbers do not depend on when the suite runs. Hours and days of history cannot be produced by waiting, so they arrive
// the way a long-running board's history does: a Kanera export carrying each card's clock, imported
// into a workspace this test owns (flagging lists is a shared, workspace-wide change).

const HOUR_S = 60 * 60;
const DAY_S = 24 * HOUR_S;

type Workspace = { workspaceId: string; lists: Map<string, string> };

async function createWorkspace(api: APIRequestContext, name: string): Promise<Workspace> {
  const created = await api.post("/api/workspaces", {
    data: {
      name,
      lists: [{ name: "Todo", icon: "circle" }, { name: "Doing", icon: "progress", inProgress: true }, { name: "Done", icon: "circle-check" }],
      timeZone: "UTC",
      customFields: [],
      labels: [],
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = ((await created.json()) as { id: string }).id;
  const source = await api.post(`/api/workspaces/${workspaceId}/boards`, { data: { name: `${name} source` } });
  expect(source.ok(), await source.text()).toBe(true);
  const sourceId = ((await source.json()) as { id: string }).id;
  const detail = await api.get(`/api/boards/${sourceId}?includeCards=false`);
  const { lists } = (await detail.json()) as { lists: { id: string; name: string }[] };
  return { workspaceId, lists: new Map(lists.map((list) => [list.name, list.id])) };
}

type ImportedCard = { title: string; list: "Todo" | "Doing"; runningForSeconds: number | null; bankedSeconds: number };

/** Imports a board whose cards carry the given clocks; returns the new board's id. */
async function importTrackedBoard(api: APIRequestContext, ws: Workspace, boardName: string, cards: ImportedCard[]): Promise<string> {
  const scratch = await api.post(`/api/workspaces/${ws.workspaceId}/boards`, { data: { name: `${boardName} export` } });
  expect(scratch.ok(), await scratch.text()).toBe(true);
  const scratchId = ((await scratch.json()) as { id: string }).id;
  for (const card of cards) {
    const created = await api.post(`/api/boards/${scratchId}/lists/${ws.lists.get("Todo")}/cards`, { data: { title: card.title } });
    expect(created.ok(), await created.text()).toBe(true);
  }
  const exported = await api.get(`/api/boards/${scratchId}/export`);
  expect(exported.ok(), await exported.text()).toBe(true);
  const archive = (await exported.json()) as { cards: Record<string, unknown>[] };
  const byTitle = new Map(cards.map((card) => [card.title, card]));
  archive.cards = archive.cards.map((row) => {
    const card = byTitle.get(row.title as string)!;
    const since = card.runningForSeconds === null ? null : new Date(Date.now() - card.runningForSeconds * 1000).toISOString();
    return { ...row, listId: ws.lists.get(card.list), listEnteredAt: since ?? row.listEnteredAt, inProgressSince: since, inProgressSeconds: card.bankedSeconds };
  });

  const analyzed = await api.post(`/api/workspaces/${ws.workspaceId}/imports/kanera-board/analyze`, {
    multipart: { file: { name: "board.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(archive)) } },
  });
  expect(analyzed.ok(), await analyzed.text()).toBe(true);
  const { importId, manifest } = (await analyzed.json()) as { importId: string; manifest: { lists: { id: string }[] } };
  const committed = await api.post(`/api/imports/kanera-board/${importId}/commit`, {
    data: {
      board: { name: boardName, icon: "layout-kanban" },
      lists: Object.fromEntries(manifest.lists.map((list) => [list.id, { action: "map", targetListId: list.id }])),
      labels: {},
      customFields: {},
      members: {},
      options: { includeArchived: false, importComments: false, importCustomFields: false, attachmentCopyMode: "skip" },
    },
  });
  expect(committed.ok(), await committed.text()).toBe(true);
  return ((await committed.json()) as { createdBoardId: string }).createdBoardId;
}

async function cardIdByTitle(api: APIRequestContext, boardId: string, title: string): Promise<string> {
  const response = await api.post(`/api/boards/${boardId}/open`);
  expect(response.ok(), await response.text()).toBe(true);
  const { cards } = (await response.json()) as { cards: { id: string; title: string }[] };
  return cards.find((card) => card.title === title)!.id;
}

function tile(page: Page, title: string): Locator {
  return page.locator("k-card").filter({ hasText: title });
}

test("time in progress accumulates across stints and shows on tiles, card detail, Work done and table totals", async ({ page, signIn, apiAs, uniqueName }) => {
  const api = await apiAs("amelia");
  const ws = await createWorkspace(api, uniqueName("E2E Track WS"));
  const boardName = uniqueName("E2E Track Board");
  // Two weeks into its current stint (80 working hours), on top of 16 hours from earlier stints:
  // 96 hours tracked.
  const running = uniqueName("E2E running 96 hours");
  // Three hours from earlier stints, not in progress now.
  const stopped = uniqueName("E2E stopped three hours");
  const boardId = await importTrackedBoard(api, ws, boardName, [
    { title: running, list: "Doing", runningForSeconds: 14 * DAY_S, bankedSeconds: 16 * HOUR_S },
    { title: stopped, list: "Todo", runningForSeconds: null, bankedSeconds: 3 * HOUR_S },
  ]);
  const runningId = await cardIdByTitle(api, boardId, running);

  await signIn(page, "amelia");
  await page.goto(`/b/${boardId}`);
  await expectBoardLoaded(page, boardName);

  // Tiles show the tracked total in hours (computed live on the client with the same working-hours
  // rule as the server): running in the accent, stopped muted but still there.
  const runningChip = tile(page, running).locator(".card-time-in-progress");
  const stoppedChip = tile(page, stopped).locator(".card-time-in-progress");
  await expect(runningChip).toHaveText(/^\s*96h\s*$/);
  await expect(runningChip).not.toHaveClass(/\bis-done\b/);
  // The alert reads the current stint's calendar span (two weeks); the label names it and the total.
  await expect(runningChip).toHaveAttribute("aria-label", /^In progress since .* \(2 weeks\) · 96 hours tracked, past the 7-day alert$/);
  await expect(stoppedChip).toHaveText(/^\s*3h\s*$/);
  await expect(stoppedChip).toHaveClass(/\bis-done\b/);
  await expect(stoppedChip).toHaveAttribute("aria-label", "3 hours tracked in progress");

  // Card detail: the tracked time sits above the description, for the list-independent reading.
  await tile(page, running).click();
  const detail = page.getByRole("dialog", { name: `Card detail: ${running}` });
  const timer = detail.locator(".col-main .detail-time-in-progress");
  await expect(timer).toContainText("In progress");
  await expect(timer.locator("strong")).toHaveText(/^96h( \d+m)?$/);
  const aboveDescription = await timer.evaluate((element) => {
    const description = Array.from(element.parentElement!.querySelectorAll(".section-label")).find((label) => label.textContent?.includes("Description"));
    return Boolean(description && element.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(aboveDescription).toBe(true);
  await page.screenshot({ path: test.info().outputPath("card-detail-time.png") });
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();

  // Leaving progress banks the stint's working time: the tile keeps its 96 hours, stopped, live.
  const moved = await api.post(`/api/cards/${runningId}/move`, { data: { listId: ws.lists.get("Done"), afterCardId: null } });
  expect(moved.ok(), await moved.text()).toBe(true);
  expect(((await moved.json()) as { inProgressSeconds: number }).inProgressSeconds).toBeGreaterThanOrEqual(96 * HOUR_S);
  await expect(runningChip).toHaveClass(/\bis-done\b/);
  await expect(runningChip).toHaveText(/^\s*96h\s*$/);
  await page.screenshot({ path: test.info().outputPath("board-stopped-time.png") });

  // The table sums and averages it like a number field.
  await page.getByRole("button", { name: "Table view" }).click();
  const table = page.locator("k-board-table-view");
  await expect(table.locator(`.tv-row[data-card-id="${runningId}"] [data-col="inProgress"] .tv-time-in-progress`)).toHaveText(/96h/);
  const calculate = table.locator(".tv-footer .tv-aggregate-btn");
  await expect(calculate).toHaveCount(1);
  await calculate.click();
  await page.locator(".tv-aggregate-menu button", { hasText: "Sum" }).click();
  await expect(calculate).toContainText("SUM");
  await expect(calculate.locator("strong")).toHaveText("99h");
  await calculate.click();
  await page.locator(".tv-aggregate-menu button", { hasText: "Average" }).click();
  // (96h + 3h) / 2 cards with tracked time.
  await expect(calculate.locator("strong")).toHaveText("49h 30m");
  await page.screenshot({ path: test.info().outputPath("table-time-average.png") });
  // Survives a reload (the choice is a table preference; the values come from the server).
  await page.reload();
  await expect(table.locator(".tv-footer .tv-aggregate-btn strong")).toHaveText("49h 30m");

  // Completing keeps the total, and Work done shows it beside what happened.
  const completed = await api.patch(`/api/cards/${runningId}/completion`, { data: { completed: true } });
  expect(completed.ok(), await completed.text()).toBe(true);
  await page.getByRole("button", { name: "Work done", exact: true }).click();
  const workDoneRow = page.locator(".wd-row").filter({ hasText: running });
  await expect(workDoneRow.first()).toBeVisible();
  const workDoneChip = workDoneRow.first().locator(".wd-chip--time");
  await expect(workDoneChip).toHaveText(/^\s*96h\s*$/);
  await expect(workDoneChip).not.toHaveClass(/\bis-running\b/);
  await page.screenshot({ path: test.info().outputPath("work-done-time.png") });
});
