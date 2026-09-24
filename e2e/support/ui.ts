import { expect, type Locator, type Page } from "@playwright/test";
import { webOrigin } from "./env";

/** The sidebar href (`/b/:id`) of a board the signed-in user can see. */
export async function boardHref(page: Page, boardName: string): Promise<string> {
  const href = await page.locator("a.board-link").filter({ hasText: boardName }).first().getAttribute("href");
  expect(href, `sidebar link for ${boardName}`).toMatch(/^\/b\/[^/]+$/);
  return href!;
}

/** The workspace settings href (`/w/:id/settings`) of the workspace that contains `boardName`. */
export async function workspaceSettingsHref(page: Page, boardName: string): Promise<string> {
  const group = page.locator(".ws-group").filter({ has: page.locator("a.board-link").filter({ hasText: boardName }) }).first();
  const href = await group.locator("a.ws-settings").getAttribute("href");
  expect(href, `workspace settings link for ${boardName}`).toMatch(/^\/w\/[^/]+\/settings$/);
  return href!;
}

/**
 * Waits for the board's data, not just its route. `k-board` (the canvas) and the header render
 * before the board request resolves and before any access check, so they prove nothing; the h1
 * replaces the header skeleton only once `BoardState` holds the loaded board.
 */
export async function expectBoardLoaded(page: Page, boardName: string) {
  await expect(page.getByRole("heading", { level: 1, name: boardName })).toBeVisible();
}

export async function openBoard(page: Page, boardName: string) {
  await page.locator("a.board-link").filter({ hasText: boardName }).first().click();
  await expectBoardLoaded(page, boardName);
}

/** Access denial redirects home without ever showing the board's data. */
export async function expectBoardDenied(page: Page, boardName: string, timeout?: number) {
  await expect(page).toHaveURL(`${webOrigin}/`, { timeout });
  await expect(page.getByRole("heading", { level: 1, name: boardName })).toHaveCount(0);
}

export function cardTile(page: Page, title: string): Locator {
  return page.locator("k-card").filter({ hasText: title });
}

/** Creates a card through the board's "New card" composer and waits for the tile. */
export async function createCard(page: Page, title: string) {
  await page.getByRole("button", { name: "New card", exact: true }).click();
  const composer = page.getByRole("dialog", { name: "New card" });
  await composer.locator("textarea.cmp-title-input").fill(title);
  await composer.getByRole("button", { name: "Create card" }).click();
  await expect(composer).toBeHidden();
  await expect(cardTile(page, title)).toHaveCount(1);
}

export async function openCard(page: Page, title: string): Promise<Locator> {
  await cardTile(page, title).click();
  const detail = page.getByRole("dialog", { name: `Card detail: ${title}` });
  await expect(detail).toBeVisible();
  return detail;
}

/** Workspace lists append on the right; scroll so newly added columns are in view. */
export async function scrollBoardToEnd(page: Page) {
  await page.locator("k-board").evaluate((board) => board.scrollTo({ left: board.scrollWidth }));
}

export async function moveCardToBoard(detail: Locator, boardName: string) {
  await detail.getByRole("button", { name: "Card actions" }).click();
  await detail.getByRole("button", { name: "Move to board…" }).click();
  await detail.locator("k-board-picker .pl-row").filter({ hasText: boardName }).click();
}

// Card-detail edits, as a person makes them. Each waits for the editor's own view to settle so a
// following assertion on another user's page measures delivery, not the editor's local latency.

export async function renameCard(detail: Locator, title: string) {
  await detail.locator("h2.card-title").click();
  await detail.locator("input.title-input").fill(title);
  await detail.locator("input.title-input").press("Enter");
  await expect(detail.locator("h2.card-title")).toHaveText(title);
}

export async function setDescription(detail: Locator, text: string) {
  await detail.locator(".description-viewer-wrap").click();
  const editor = detail.locator("k-description-editor");
  await editor.locator(".tiptap").fill(text);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(detail.locator(".description-viewer-wrap")).toContainText(text);
}

export async function moveCardToList(detail: Locator, listName: string) {
  await detail.locator(".move-list-btn:visible").first().click();
  await detail.locator(".move-list-popover .move-list-option").filter({ hasText: listName }).click();
  await expect(detail.locator(".move-list-btn:visible").first()).toContainText(listName);
}

export async function completeCard(detail: Locator) {
  await detail.getByRole("button", { name: "Mark complete" }).click();
  await expect(detail.getByRole("button", { name: "Mark incomplete" })).toBeVisible();
}
