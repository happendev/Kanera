import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { boardHref, openBoard } from "./support/ui";

async function cardForKeyboardReview(page: Page, api: APIRequestContext, title: string) {
  const href = await boardHref(page, "Platform Delivery");
  const board = await api.get(`/api/boards/${href.split("/")[2]}?includeCards=false`);
  expect(board.ok()).toBe(true);
  const { lists } = await board.json() as { lists: { id: string }[] };
  const response = await api.post(`/api/boards/${href.split("/")[2]}/lists/${lists[0]!.id}/cards`, {
    data: { title, atTop: true },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const card = await response.json() as { id: string };
  await page.goto(`${href}/c/${card.id}`);
  const detail = page.getByRole("dialog", { name: `Card detail: ${title}`, exact: true });
  await expect(detail.getByRole("button", { name: "Mark complete", exact: true })).toBeEnabled();
  await detail.focus();
  return { ...card, detail };
}

test("search over a card keeps Tab focus inside the top dialog", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  await signIn(page, "priya");
  const api = await apiAs("priya");
  const card = await cardForKeyboardReview(page, api, uniqueName("Keyboard focus"));
  try {
    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByRole("dialog", { name: "Search", exact: true });
    await expect(search.getByRole("combobox", { name: "Search", exact: true })).toBeFocused();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const key of ["Tab", "Tab", "Shift+Tab"]) {
        await page.keyboard.press(key);
        await expect.poll(() => search.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      }
      await page.screenshot({ path: testInfo.outputPath(`search-over-card-${width}.png`) });
    }
  } finally {
    expect((await api.patch(`/api/cards/${card.id}/archive`, { data: { archived: true } })).ok()).toBe(true);
  }
});

test("shortcut help suspends background board and card actions", async ({ page, signIn, apiAs, uniqueName }) => {
  await signIn(page, "priya");
  await openBoard(page, "Platform Delivery");
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
  await expect(help.getByRole("searchbox")).toBeFocused();
  await page.keyboard.press("Tab");
  const close = help.getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeFocused();
  await page.keyboard.press("c");
  await expect(close).toBeFocused();
  await expect(page.getByRole("dialog", { name: "New card", exact: true })).toHaveCount(0);
  await close.click();

  const api = await apiAs("priya");
  const card = await cardForKeyboardReview(page, api, uniqueName("Keyboard scope"));
  try {
    // Help remains deliberately available from a card; card mutations do not remain available
    // from help's search input, even though modifier chords normally work inside text fields.
    await page.keyboard.press("?");
    await expect(help.getByRole("searchbox")).toBeFocused();
    await page.keyboard.press("ControlOrMeta+Enter");
    await close.click();
    await expect(card.detail.getByRole("button", { name: "Mark complete", exact: true })).toBeVisible();
    const saved = await api.get(`/api/cards/${card.id}/detail`);
    expect(saved.ok()).toBe(true);
    expect((await saved.json() as { card: { completedAt: string | null } }).card.completedAt).toBeNull();
  } finally {
    expect((await api.patch(`/api/cards/${card.id}/archive`, { data: { archived: true } })).ok()).toBe(true);
  }
});

test("the title shortcut focuses the input on boards and Team Cards", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  await signIn(page, "priya");
  const api = await apiAs("priya");
  const card = await cardForKeyboardReview(page, api, uniqueName("Keyboard title"));
  try {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await card.detail.focus();
      await page.keyboard.press("e");
      const title = card.detail.locator("input.title-input");
      await expect(title).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath(`title-focus-${width}.png`) });
      // Commit the unchanged title. The second pass exercises the shared drawer in Global Work.
      await page.keyboard.press("Enter");
      if (width === 1280) {
        await page.goto(`/team-cards/c/${card.id}`);
        await expect(card.detail.getByRole("button", { name: "Mark complete", exact: true })).toBeEnabled();
      }
    }
  } finally {
    expect((await api.patch(`/api/cards/${card.id}/archive`, { data: { archived: true } })).ok()).toBe(true);
  }
});

test("a pending navigation sequence cannot consume input text", async ({ page, signIn }) => {
  await signIn(page, "priya");
  await openBoard(page, "Platform Delivery");
  const url = page.url();
  await page.keyboard.press("g");
  const search = page.getByRole("searchbox", { name: "Search cards", exact: true });
  await search.focus();
  await page.keyboard.press("h");
  await expect(search).toHaveValue("h");
  await expect(page).toHaveURL(url);
  await search.fill("");
});

test("utility shortcuts can still close the drawer that owns them", async ({ page, signIn }) => {
  await signIn(page, "priya");
  for (const [key, name, closeLabel] of [["n", "Notifications", "Close notifications"], ["u", "Up next", "Close Up next"]]) {
    await page.keyboard.press(key!);
    const drawer = page.getByRole("dialog", { name, exact: true });
    await expect(drawer.getByRole("button", { name: closeLabel, exact: true })).toBeFocused();
    await page.keyboard.press(key!);
    await expect(drawer).toHaveCount(0);
  }
});
