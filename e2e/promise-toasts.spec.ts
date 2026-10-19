import type { APIRequestContext, APIResponse, Locator, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { cardTile, expectBoardLoaded } from "./support/ui";

async function result<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

async function createWorkspace(api: APIRequestContext, name: string) {
  return result<{ id: string; name: string }>(await api.post("/api/workspaces", {
    data: { name, lists: [{ name: "Todo" }, { name: "Doing" }] },
  }));
}

function gate() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  return { pending, release };
}

async function sameToast(toast: Locator) {
  const node = await toast.elementHandle();
  expect(node).not.toBeNull();
  return async (variant: "success" | "error") => {
    expect(await node!.evaluate((el, tone) => el.isConnected && el.getAttribute("data-variant") === tone, variant)).toBe(true);
  };
}

async function selectCards(page: Page, titles: string[]) {
  for (const title of titles) await cardTile(page, title).click({ modifiers: ["ControlOrMeta"] });
  await page.locator(".bulk-selection-trigger").click();
}

test("bulk moves and archive settle in place, preserve Undo, and report failure", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const ws = await createWorkspace(api, uniqueName("Promise bulk"));
  try {
    const board = await result<{ id: string; name: string }>(await api.post(`/api/workspaces/${ws.id}/boards`, { data: { name: uniqueName("Promise board") } }));
    const detail = await result<{ lists: { id: string; name: string }[] }>(await api.get(`/api/boards/${board.id}?includeCards=false`));
    const [todo, doing] = detail.lists;
    const titles = [uniqueName("First card"), uniqueName("Second card")];
    const cards = [];
    for (const title of titles) cards.push(await result<{ id: string }>(await api.post(`/api/boards/${board.id}/lists/${todo!.id}/cards`, { data: { title } })));
    await signIn(page, "amelia");
    await page.goto(`/b/${board.id}`);
    await expectBoardLoaded(page, board.name);
    const move = gate();
    await page.route(`**/boards/${board.id}/cards/bulk/move`, async (route) => {
      const response = await route.fetch();
      await move.pending;
      await route.fulfill({ response });
    });
    await selectCards(page, titles);
    await page.getByRole("button", { name: "Move to list" }).click();
    await page.locator(".bcam-picker").getByRole("button", { name: doing!.name }).click();
    const toast = page.locator('.toast').filter({ hasText: "Updating cards…" });
    await expect(toast).toHaveAttribute("data-variant", "loading");
    const moved = await sameToast(toast);
    await page.screenshot({ path: testInfo.outputPath("promise-loading-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("promise-loading-phone.png"), fullPage: true });
    move.release();
    // Text and icon settle without replacing the loading node.
    const settled = page.locator('.toast[data-variant="success"]').filter({ hasText: "2 cards moved" });
    await expect(settled).toBeVisible();
    await moved("success");
    await settled.getByRole("button", { name: "Dismiss notification" }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await selectCards(page, titles);
    const archive = gate();
    await page.route(`**/boards/${board.id}/cards/bulk/archive`, async (route) => {
      const response = await route.fetch();
      await archive.pending;
      await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "Archive cards" }).click();
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.locator('.toast[data-variant="loading"]')).toBeVisible();
    archive.release();
    const archived = page.locator('.toast[data-variant="success"]').filter({ hasText: "2 cards archived" });
    await expect(archived.getByRole("button", { name: "Undo" })).toBeVisible();
    await archived.getByRole("button", { name: "Undo" }).click();
    for (const title of titles) await expect(cardTile(page, title)).toBeVisible();
    await page.route(`**/boards/${board.id}/cards/bulk/move`, (route) => route.fulfill({ status: 409, json: { message: "Move rejected" } }));
    await selectCards(page, titles);
    await page.getByRole("button", { name: "Move to list" }).click();
    await page.locator(".bcam-picker").getByRole("button", { name: todo!.name }).click();
    const failed = page.locator('.toast[data-variant="error"]');
    await expect(failed).toContainText("Couldn't update all selected cards.");
    await expect(failed.getByRole("button", { name: "Undo" })).toHaveCount(0);
    for (const card of cards) {
      const saved = await result<{ card: { listId: string; archivedAt: string | null } }>(await api.get(`/api/cards/${card.id}/detail`));
      expect(saved.card).toMatchObject({ listId: doing!.id, archivedAt: null });
    }
  } finally {
    await api.delete(`/api/workspaces/${ws.id}`, { data: { confirmationName: ws.name } });
  }
});

test("board exports keep one toast through download or failure and respect dismissal", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const ws = await createWorkspace(api, uniqueName("Promise export"));
  try {
    const board = await result<{ id: string; name: string }>(await api.post(`/api/workspaces/${ws.id}/boards`, { data: { name: uniqueName("Export board") } }));
    await signIn(page, "amelia");
    await page.goto(`/b/${board.id}`);
    await expectBoardLoaded(page, board.name);
    const downloadGate = gate();
    await page.route(`**/boards/${board.id}/export`, async (route) => {
      const response = await route.fetch();
      await downloadGate.pending;
      await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "Board menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "JSON" }).click();
    const toast = page.locator('.toast[data-variant="loading"]');
    await expect(toast).toContainText("Preparing export…");
    const node = await toast.elementHandle();
    const download = page.waitForEvent("download");
    downloadGate.release();
    expect((await download).suggestedFilename()).toMatch(/\.json$/);
    await expect(page.locator('.toast[data-variant="success"]')).toContainText("Export downloaded.");
    expect(await node!.evaluate((el) => el.isConnected && el.getAttribute("data-variant") === "success")).toBe(true);
    await page.locator('.toast').getByRole("button", { name: "Dismiss notification" }).click();
    const failure = gate();
    await page.route(`**/boards/${board.id}/export`, async (route) => {
      await failure.pending;
      await route.fulfill({ status: 409, json: { message: "Export rejected" } });
    });
    await page.getByRole("button", { name: "Board menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "Excel" }).click();
    await expect(page.locator('.toast[data-variant="loading"]')).toBeVisible();
    failure.release();
    await expect(page.getByRole("alert")).toContainText("Couldn't export. Try again.");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("promise-error-phone.png"), fullPage: true });
    await page.getByRole("alert").getByRole("button", { name: "Dismiss notification" }).click();
    const dismissed = gate();
    await page.route(`**/boards/${board.id}/export`, async (route) => {
      const response = await route.fetch();
      await dismissed.pending;
      await route.fulfill({ response });
    });
    const boardMenu = page.getByRole("button", { name: "Board menu", exact: true });
    await page.keyboard.press("Escape");
    await expect(boardMenu).toHaveAttribute("aria-expanded", "false");
    await boardMenu.click();
    await page.getByRole("menuitem", { name: "JSON" }).click();
    const loading = page.locator('.toast[data-variant="loading"]');
    await expect(loading).toBeVisible();
    await loading.getByRole("button", { name: "Dismiss notification" }).click();
    const lateDownload = page.waitForEvent("download");
    dismissed.release();
    await lateDownload;
    await expect(page.locator('.toast:not(.leaving)')).toHaveCount(0);
  } finally {
    await api.delete(`/api/workspaces/${ws.id}`, { data: { confirmationName: ws.name } });
  }
});

test("Trello import settles its loading toast after the real import", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const ws = await createWorkspace(api, uniqueName("Promise import"));
  try {
    await signIn(page, "amelia");
    await page.goto(`/w/${ws.id}/settings/import`);
    const wizard = page.locator("k-trello-import");
    await wizard.locator('input[type="file"]').setInputFiles({
      name: "trello.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ name: "Imported", lists: [{ id: "todo", name: "Todo" }], cards: [{ id: "one", idList: "todo", name: "Imported card", closed: false }] })),
    });
    await wizard.locator('button[type="submit"]').click();
    for (let step = 0; step < 8 && !(await wizard.locator(".import-action button").isVisible()); step++) {
      const heading = wizard.getByRole("heading", { level: 3 });
      const previous = await heading.innerText();
      await wizard.getByRole("button", { name: "Next", exact: false }).click();
      await expect(heading).not.toHaveText(previous);
    }
    const commit = gate();
    await page.route("**/imports/*/commit", async (route) => {
      const response = await route.fetch();
      await commit.pending;
      await route.fulfill({ response });
    });
    await wizard.locator(".import-action button").click();
    const toast = page.locator('.toast[data-variant="loading"]');
    await expect(toast).toContainText("Importing board…");
    const node = await toast.elementHandle();
    commit.release();
    await expect(page.locator('.toast[data-variant="success"]')).toContainText("Board imported.");
    expect(await node!.evaluate((el) => el.isConnected && el.getAttribute("data-variant") === "success")).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("promise-import-success.png"), fullPage: true });
  } finally {
    await api.delete(`/api/workspaces/${ws.id}`, { data: { confirmationName: ws.name } });
  }
});
