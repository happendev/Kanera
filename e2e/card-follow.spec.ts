import type { APIRequestContext, APIResponse } from "@playwright/test";
import { webOrigin } from "./support/env";
import { expect, test } from "./support/fixtures";
import { boardIdOf, cardTile, createCard, openBoard, openCard } from "./support/ui";

const v1 = "/public-api/api/v1";

async function result<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

async function cardIdByTitle(api: APIRequestContext, boardId: string, title: string): Promise<string> {
  const board = await result<{ cards: { id: string; title: string }[] }>(await api.post(`/api/boards/${boardId}/open`));
  const card = board.cards.find((row) => row.title === title);
  expect(card, `${title} exists on the board`).toBeDefined();
  return card!.id;
}

// Watch and reminder state is personal, so it travels on the user room only. These checks prove a
// second session of the same person converges without a reload, including writes made through the
// public API process (direct outbox drained by the worker), and that the worker's reminder sweep
// lands a notification in the inbox.
test("reminders and watching follow the user across sessions and processes, and a due reminder reaches the inbox", async ({ page, testWorkspace, signIn, pageAs, apiAs, playwright, uniqueName }) => {
  test.setTimeout(120_000);
  const title = uniqueName("E2E reminder card");
  await signIn(page, "amelia");
  const otherTab = await pageAs("amelia");
  await openBoard(page, testWorkspace.boardName);
  await openBoard(otherTab, testWorkspace.boardName);
  await createCard(page, title);
  await expect(cardTile(otherTab, title)).toBeVisible();

  // Set a reminder the way a person does: the alarm button in card detail.
  const detail = await openCard(page, title);
  await detail.getByRole("button", { name: "Remind me" }).click();
  await page.getByRole("dialog", { name: "Remind me" }).getByRole("button", { name: /Tomorrow morning/ }).click();
  await expect(detail.locator(".reminder-btn")).toHaveClass(/has-reminder/);
  // The other session learns about it live and marks the tile.
  await expect(cardTile(otherTab, title).locator(".card-reminder-indicator")).toBeVisible();

  const api = await apiAs("amelia");
  const boardId = await boardIdOf(page, testWorkspace.boardName);
  const cardId = await cardIdByTitle(api, boardId, title);

  // Compose a time instead: a day from next month's calendar plus a typed time, nudged by ArrowUp.
  await detail.locator(".reminder-btn").click();
  const picker = page.getByRole("dialog", { name: "Remind me" });
  await picker.getByRole("button", { name: "Next month" }).click();
  await picker.locator(".rp-day:not(.is-muted)").filter({ hasText: /^\s*15\s*$/ }).click();
  const time = picker.getByRole("textbox", { name: "Time" });
  await time.fill("4:10pm");
  await time.press("ArrowUp");
  await expect(time).toHaveValue(/16:15|4:15/);
  await picker.getByRole("button", { name: "Set reminder" }).click();
  await expect(picker).toBeHidden();
  const composed = await result<{ reminder: { remindAt: string } | null }>(await api.get(`/api/cards/${cardId}/follow`));
  const local = await page.evaluate((iso) => { const d = new Date(iso); return [d.getDate(), d.getHours(), d.getMinutes()]; }, composed.reminder!.remindAt);
  expect(local).toEqual([15, 16, 15]);

  // Completing the card clears the reminder, and every open session drops the alarm live.
  await expect(cardTile(otherTab, title).locator(".card-reminder-indicator")).toBeVisible();
  await result(await api.patch(`/api/cards/${cardId}/completion`, { data: { completed: true } }));
  await expect(cardTile(otherTab, title).locator(".card-reminder-indicator")).toHaveCount(0);
  await expect(detail.locator(".reminder-btn")).not.toHaveClass(/has-reminder/);
  await result(await api.patch(`/api/cards/${cardId}/completion`, { data: { completed: false } }));
  const key = await result<{ secret: string; id: string }>(await api.post("/api/me/api-keys", { data: { label: uniqueName("E2E follow key"), scope: "write" } }));
  const publicApi = await playwright.request.newContext({ baseURL: webOrigin, extraHTTPHeaders: { authorization: `Bearer ${key.secret}` } });
  try {
    // Watching through the public API reaches the open card detail through the worker.
    const watching = await result<{ watching: boolean }>(await publicApi.put(`${v1}/cards/${cardId}/watch`));
    expect(watching.watching).toBe(true);
    await expect(detail.locator(".watch-btn")).toHaveClass(/is-watching/);
    // Viewing a card reads its notifications, so close it before the reminder fires.
    await page.keyboard.press("Escape");
    await expect(detail).toBeHidden();

    // Re-arm the reminder a few seconds out; the worker sweep (30s cadence) fires it.
    const remindAt = new Date(Date.now() + 3_000).toISOString();
    const state = await result<{ reminder: { remindAt: string } | null }>(await publicApi.put(`${v1}/cards/${cardId}/reminder`, { data: { remindAt } }));
    expect(state.reminder?.remindAt).toBe(remindAt);

    await otherTab.getByRole("button", { name: /^Notifications/ }).click();
    const notification = otherTab.locator(".notif-item").filter({ hasText: title });
    await expect(notification).toBeVisible({ timeout: 60_000 });
    await expect(notification.locator(".notif-reminder-badge")).toHaveText("Your reminder");
    // Fired reminders no longer light the tile or the button.
    await expect(cardTile(otherTab, title).locator(".card-reminder-indicator")).toHaveCount(0);
    const reopened = await openCard(page, title);
    await expect(reopened.locator(".reminder-btn")).not.toHaveClass(/has-reminder/);

    const pending = await result<unknown[]>(await publicApi.get(`${v1}/reminders`));
    expect(pending.filter((row) => (row as { cardId: string }).cardId === cardId)).toHaveLength(0);
  } finally {
    await api.delete(`/api/me/api-keys/${key.id}`);
    await publicApi.dispose();
  }
});

test("a reminder can be set from a card's right-click menu without opening the card", async ({ page, testWorkspace, signIn, uniqueName }) => {
  const title = uniqueName("E2E menu reminder card");
  await signIn(page, "amelia");
  await openBoard(page, testWorkspace.boardName);
  await createCard(page, title);

  const tile = cardTile(page, title);
  await tile.click({ button: "right" });
  await page.getByRole("button", { name: "Remind me…" }).click();
  const picker = page.getByRole("dialog", { name: "Remind me" });
  // Typing goes to the time field, not the menu's type-to-select.
  const time = picker.getByRole("textbox", { name: "Time" });
  await time.fill("1015");
  await expect(time).toHaveValue("1015");
  await picker.getByRole("button", { name: /Tomorrow morning/ }).click();

  await expect(picker).toBeHidden();
  await expect(tile.locator(".card-reminder-indicator")).toBeVisible();
  await expect(page.locator("k-card-detail .panel")).toHaveCount(0);

  await tile.click({ button: "right" });
  await expect(page.getByRole("button", { name: "Change reminder…" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("Home lists your upcoming reminders live, and the board can filter to the cards you set one on", async ({ page, testWorkspace, signIn, pageAs, uniqueName }) => {
  const reminded = uniqueName("E2E reminded card");
  const other = uniqueName("E2E unreminded card");
  await signIn(page, "amelia");
  const home = await pageAs("amelia");
  await home.goto(`${webOrigin}/`);
  await openBoard(page, testWorkspace.boardName);
  await createCard(page, reminded);
  await createCard(page, other);

  // Set from the board session; the Home session learns about it over the user room.
  await cardTile(page, reminded).click({ button: "right" });
  await page.getByRole("button", { name: "Remind me…" }).click();
  await page.getByRole("dialog", { name: "Remind me" }).getByRole("button", { name: /Tomorrow morning/ }).click();
  const row = home.locator(".reminder-row").filter({ hasText: reminded });
  await expect(row).toBeVisible();
  await expect(row.locator(".reminder-when")).toContainText("Tomorrow");

  // The board filter keeps only cards the viewer has a pending reminder on.
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.locator(".fb-row").filter({ hasText: "Reminder set" }).click();
  await expect(cardTile(page, reminded)).toBeVisible();
  await expect(cardTile(page, other)).toHaveCount(0);

  // Clearing from Home drops it from the list and, live, from the filtered board.
  await row.getByRole("button", { name: "Clear reminder" }).click();
  await expect(row).toHaveCount(0);
  await expect(cardTile(page, reminded)).toHaveCount(0);
  await page.locator(".fb-row").filter({ hasText: "Reminder set" }).click();
  await expect(cardTile(page, other)).toBeVisible();
});
