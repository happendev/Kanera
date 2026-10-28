import { expect, type Locator, type Page } from "@playwright/test";
import { TEST_PASSWORD, webOrigin } from "./env";

/**
 * Creates a brand-new account and organisation through the signup form and stops at onboarding.
 * Returns the email, for API calls made as that account.
 */
export async function signUp(page: Page, name: string): Promise<string> {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@kanera.test`;
  await page.goto("/signup");
  await page.locator("#cname").fill(name);
  await page.locator("#dn").fill(name);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(TEST_PASSWORD);
  await page.locator("#confirm-password").fill(TEST_PASSWORD);
  await page.locator("form").getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/onboarding/);
  return email;
}

/** The sidebar href (`/b/:id`) of a board the signed-in user can see. */
export async function boardHref(page: Page, boardName: string): Promise<string> {
  const href = await page.locator("a.board-link").filter({ hasText: boardName }).first().getAttribute("href");
  expect(href, `sidebar link for ${boardName}`).toMatch(/^\/b\/[^/]+$/);
  return href!;
}

/** The id segment of `boardHref`, for API and MCP calls that address the board directly. */
export async function boardIdOf(page: Page, boardName: string): Promise<string> {
  return (await boardHref(page, boardName)).split("/")[2]!;
}

/**
 * Creates a write-scoped workspace API key the way an integrator would, from the settings API tab,
 * and returns the one-time revealed secret.
 */
export async function createWorkspaceApiKey(page: Page, settingsHref: string, name: string): Promise<string> {
  await page.goto(`${settingsHref}/api`);
  await page.locator('input[name="apiKeyName"]').fill(name);
  await page.locator('select[name="apiKeyScope"]').selectOption("write");
  await page.getByRole("button", { name: "Create API key" }).click();
  const reveal = page.locator(".secret-reveal").filter({ has: page.getByRole("button", { name: "Copy API key" }) });
  await expect(reveal).toBeVisible();
  return (await reveal.locator("code").innerText()).trim();
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
  const createdResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && /\/boards\/[^/]+\/lists\/[^/]+\/cards$/.test(new URL(response.url()).pathname) && response.ok(),
  );
  await composer.getByRole("button", { name: "Create card" }).click();
  const response = await createdResponse;
  const { listId } = await response.json() as { listId: string };
  await expect(composer).toBeHidden();
  await expectCardTileMounted(page, title, listId);
}

/**
 * Waits for a card tile to be rendered, scrolling the receiving lane so the tile mounts.
 *
 * Lanes render only their first fifteen cards until scrolled (`INITIAL_RENDER_CAP`). In scenarios
 * that deliberately create more cards, a tile that exists in state but is beyond
 * the window would otherwise fail a plain visibility check on any page observing the board, not just
 * the one that created the card. Without `listId` every lane is nudged.
 */
export async function expectCardTileMounted(page: Page, title: string, listId?: string) {
  const lanes = listId ? page.locator(`[id="dl-${listId}"]`) : page.locator('[id^="dl-"]');
  await expect.poll(async () => {
    const count = await cardTile(page, title).count();
    if (count === 0) {
      for (const lane of await lanes.all()) await lane.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    }
    return count;
  }, { timeout: 15_000 }).toBe(1);
}

export async function openCard(page: Page, title: string): Promise<Locator> {
  await expectCardTileMounted(page, title);
  await cardTile(page, title).click();
  const detail = page.getByRole("dialog", { name: `Card detail: ${title}` });
  await expect(detail).toBeVisible();
  return detail;
}

/** Incremental table mounting must not turn an off-screen retained row into a false failure. */
export async function expectTableRowMounted(page: Page, cardId: string) {
  const row = page.locator(`.tv-row[data-card-id="${cardId}"]`);
  await expect.poll(async () => {
    if (await row.count() === 0) {
      await page.locator(".tv-scroll").evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
    }
    return row.count();
  }).toBe(1);
  return row;
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
