import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { expectBoardLoaded } from "./support/ui";

// Limits on work in progress: a list's WIP limit, the workspace's time-in-progress alert, and the
// board's "In progress" quick filter. The test owns its workspace because both settings are shared,
// workspace-wide changes. Aged work cannot be produced by waiting, so it arrives the way a
// long-running board's history does: a Kanera export carrying a card that has been in progress for
// two weeks, imported into this workspace (which also proves imports keep that clock). The workspace
// works in UTC, where any two weeks hold exactly 80 working hours whenever the suite runs.

const DAY_MS = 24 * 60 * 60 * 1000;

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

/** Imports a board whose one card has been in "Doing" for two weeks; returns the new board's id. */
async function importAgedBoard(api: APIRequestContext, ws: Workspace, boardName: string, cardTitle: string): Promise<string> {
  const scratch = await api.post(`/api/workspaces/${ws.workspaceId}/boards`, { data: { name: `${boardName} export` } });
  expect(scratch.ok(), await scratch.text()).toBe(true);
  const scratchId = ((await scratch.json()) as { id: string }).id;
  const card = await api.post(`/api/boards/${scratchId}/lists/${ws.lists.get("Todo")}/cards`, { data: { title: cardTitle } });
  expect(card.ok(), await card.text()).toBe(true);
  const exported = await api.get(`/api/boards/${scratchId}/export`);
  expect(exported.ok(), await exported.text()).toBe(true);
  const archive = (await exported.json()) as { cards: Record<string, unknown>[] };
  const twoWeeksAgo = new Date(Date.now() - 14 * DAY_MS).toISOString();
  // As exported from a board where this card entered "Doing" two weeks ago.
  archive.cards = archive.cards.map((row) => ({ ...row, listId: ws.lists.get("Doing"), listEnteredAt: twoWeeksAgo, inProgressSince: twoWeeksAgo }));

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

async function createCard(api: APIRequestContext, boardId: string, listId: string, title: string): Promise<string> {
  const created = await api.post(`/api/boards/${boardId}/lists/${listId}/cards`, { data: { title } });
  expect(created.ok(), await created.text()).toBe(true);
  return ((await created.json()) as { id: string }).id;
}

function tile(page: Page, title: string): Locator {
  return page.locator("k-card").filter({ hasText: title });
}

function column(page: Page, name: string): Locator {
  return page.locator("k-list").filter({ has: page.locator(".list-header h3", { hasText: name }) });
}

test("a board shows WIP limits, flags work in progress too long, and filters to work in progress", async ({ page, signIn, pageAs, apiAs, uniqueName }) => {
  const api = await apiAs("amelia");
  const ws = await createWorkspace(api, uniqueName("E2E Limits Workspace"));
  const boardName = uniqueName("E2E Limits Board");
  const aged = uniqueName("E2E in progress two weeks");
  const boardId = await importAgedBoard(api, ws, boardName, aged);
  const fresh = uniqueName("E2E just started");
  const waiting = uniqueName("E2E not started");
  const freshId = await createCard(api, boardId, ws.lists.get("Todo")!, fresh);
  await createCard(api, boardId, ws.lists.get("Todo")!, waiting);

  await signIn(page, "amelia");
  await page.goto(`/b/${boardId}`);
  await expectBoardLoaded(page, boardName);

  // The imported clock survived, and two weeks is past the default 7-day alert. Two weeks tracks as
  // ten 8-hour working days.
  const agedChip = tile(page, aged).locator(".card-time-in-progress");
  await expect(agedChip).toHaveText(/^\s*80h\s*$/);
  await expect(agedChip).toHaveClass(/\bis-alert\b/);
  await expect(agedChip).toHaveAttribute("aria-label", /past the 7-day alert/);

  // A WIP limit set in workspace settings reaches the open board live.
  const settings = await pageAs("amelia");
  await settings.goto(`/w/${ws.workspaceId}/settings/lists`);
  const wip = settings.getByRole("spinbutton", { name: "WIP limit for Doing" });
  await wip.fill("1");
  await wip.press("Tab");
  await expect(column(page, "Doing").locator(".list-wip")).toHaveText("1/1");
  await expect(column(page, "Doing").locator(".list-wip")).not.toHaveClass(/\bis-over\b/);

  // Going over it flags the column; the newly started card is not past the alert.
  const moved = await api.post(`/api/cards/${freshId}/move`, { data: { listId: ws.lists.get("Doing"), afterCardId: null } });
  expect(moved.ok(), await moved.text()).toBe(true);
  await expect(column(page, "Doing").locator(".list-wip")).toHaveText("2/1");
  await expect(column(page, "Doing").locator(".list-wip")).toHaveClass(/\bis-over\b/);
  await expect(tile(page, fresh).locator(".card-time-in-progress")).not.toHaveClass(/\bis-alert\b/);
  await page.screenshot({ path: test.info().outputPath("board-wip-and-alert.png") });

  // The "In progress" quick filter keeps only open work in In progress lists.
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.locator(".fb-row").filter({ hasText: "In progress" }).click();
  await page.keyboard.press("Escape");
  await expect(tile(page, waiting)).toHaveCount(0);
  await expect(tile(page, aged)).toHaveCount(1);
  await expect(tile(page, fresh)).toHaveCount(1);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(tile(page, waiting)).toHaveCount(1);

  // Turning the alert off in General settings clears the flag live.
  await settings.goto(`/w/${ws.workspaceId}/settings/general`);
  const alert = settings.getByRole("spinbutton", { name: "Time in progress alert in days" });
  await expect(alert).toHaveValue("7");
  await alert.fill("0");
  await alert.press("Tab");
  await expect(agedChip).not.toHaveClass(/\bis-alert\b/);
  await expect(agedChip).toHaveAttribute("aria-label", /^In progress since .* \(2 weeks\) · 80 hours tracked$/);
  await settings.screenshot({ path: test.info().outputPath("settings-alert.png") });

  // Clearing the WIP limit removes the count.
  await settings.goto(`/w/${ws.workspaceId}/settings/lists`);
  await wip.fill("");
  await wip.press("Tab");
  await expect(column(page, "Doing").locator(".list-wip")).toHaveCount(0);
});
