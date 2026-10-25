import type { APIRequestContext, APIResponse, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { boardIdOf, expectCardTileMounted, openBoard, openCard } from "./support/ui";

// In-progress limits on the "Card in progress too long" automation, and the scheduling-conflict
// notification. The limit is edited in the real settings UI and must reach a second admin's open page
// through realtime; the conflict is found by the worker's schedule recheck and has to cross from the
// worker process to another member's open inbox. Neither hop exists in the isolated tests.

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

type Automation = {
  id: string;
  triggerType: string;
  triggerThresholdSource: string | null;
  triggerThresholdUnit: string | null;
  triggerCustomFieldId: string | null;
  triggerIncludeExisting: boolean;
};

test("the in-progress limit editor saves a number-field limit and shows it live to another admin", async ({ page, signIn, pageAs, apiAs, uniqueName }) => {
  const api = await apiAs("amelia");
  // Its own workspace: the rule and the number field are workspace-wide settings.
  const workspace = await json<{ id: string }>(await api.post("/api/workspaces", {
    data: {
      name: uniqueName("E2E Limits"),
      lists: [{ name: "Todo", icon: "circle" }, { name: "Doing", icon: "progress", inProgress: true }, { name: "Done", icon: "circle-check" }],
      customFields: [{ name: "Estimate", icon: "hourglass", type: "number" }],
      labels: [],
      timeZone: "UTC",
    },
  }));
  const settingsHref = `/w/${workspace.id}/settings/automations`;
  const fields = (await json<{ customFields: { id: string; name: string }[] }>(await api.get(`/api/workspaces/${workspace.id}`))).customFields;
  const estimate = fields.find((field) => field.name === "Estimate")!;
  // A switched-off rule with one action to edit.
  const rule = await json<Automation>(await api.post(`/api/workspaces/${workspace.id}/automations`, {
    data: { enabled: false, triggerType: "card_in_progress_too_long", actions: [{ type: "set_completion", config: { completed: true } }] },
  }));
  const ruleOf = (target: Page) => target.locator(`.automation-card[data-automation-id="${rule.id}"]`);
  const stored = async () => (await json<Automation[]>(await api.get(`/api/workspaces/${workspace.id}/automations`))).find((item) => item.id === rule.id)!;

  // Marcus, an organisation admin, keeps the same settings page open and never reloads it.
  const watcher = await pageAs("marcus");
  await watcher.goto(settingsHref);
  await expect(ruleOf(watcher).locator(".ac-title")).toHaveText("Card in progress too long");

  await signIn(page, "amelia");
  await page.goto(settingsHref);
  const card = ruleOf(page);
  await card.locator(".ac-identity").click();
  const limit = card.getByRole("combobox", { name: "Limit" });
  await expect(limit).toHaveValue("workspace");
  await expect(card).toContainText("passes the workspace alert of 7 days");

  // A number field, counted in working hours, including cards already past it.
  await limit.selectOption("custom_field");
  await expect(card.getByRole("combobox", { name: "Custom field" })).toHaveValue(estimate.id);
  await card.getByRole("combobox", { name: "Counted in" }).selectOption("hours");
  const include = card.getByRole("button", { name: "Include cards already past the limit" });
  await expect(include).toHaveAttribute("aria-pressed", "false");
  await include.click();
  await expect(include).toHaveAttribute("aria-pressed", "true");
  await expect(card).toContainText("A working day is 8 tracked hours.");
  await expect(card.locator(".ac-title")).toHaveText("Card in progress over Estimate");
  await expect.poll(async () => {
    const current = await stored();
    return [current.triggerThresholdSource, current.triggerCustomFieldId, current.triggerThresholdUnit, current.triggerIncludeExisting];
  }).toEqual(["custom_field", estimate.id, "hours", true]);
  await page.screenshot({ path: test.info().outputPath("limit-editor-desktop.png") });

  // The other admin's page caught up through realtime.
  await expect(ruleOf(watcher).locator(".ac-title")).toHaveText("Card in progress over Estimate");

  // A fixed limit in hours names its amount in the title.
  await limit.selectOption("fixed");
  const amount = card.getByRole("spinbutton", { name: "Amount" });
  await amount.fill("36");
  await amount.press("Tab");
  await card.getByRole("combobox", { name: "Unit" }).selectOption("hours");
  await expect(card.locator(".ac-title")).toHaveText("Card in progress over 36 hours");
  await expect(ruleOf(watcher).locator(".ac-title")).toHaveText("Card in progress over 36 hours");

  // On a phone the long toggle wraps inside the card instead of running off it.
  await page.setViewportSize({ width: 375, height: 812 });
  await include.scrollIntoViewIfNeeded();
  const toggleBox = (await include.boundingBox())!;
  const cardBox = (await card.boundingBox())!;
  expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
  await page.screenshot({ path: test.info().outputPath("limit-editor-phone.png") });
});

/** The Monday at least a week ahead, so no bar starts in the past or on a weekend. */
function planningMonday(): Date {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 7);
  while (date.getUTCDay() !== 1) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function day(monday: Date, offset: number): string {
  const date = new Date(monday);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

type CreatedCard = { id: string; key: string; title: string };

async function scheduledCard(api: APIRequestContext, boardId: string, listId: string, title: string, start: string, due: string): Promise<CreatedCard> {
  return json<CreatedCard>(await api.post(`/api/boards/${boardId}/lists/${listId}/cards`, { data: { title, atTop: true, startDateLocalDate: start, dueDateLocalDate: due } }));
}

type InboxRow = { cardId: string | null; activity: { action: string } | null };

async function conflictNotices(api: APIRequestContext, cardId: string): Promise<number> {
  const page = await json<{ notifications?: InboxRow[]; items?: InboxRow[] }>(await api.get("/api/notifications?includeRead=true&limit=100"));
  return (page.notifications ?? page.items ?? []).filter((row) => row.cardId === cardId && row.activity?.action === "schedule:conflict").length;
}

test("a new scheduling conflict reaches the blocked card's assignee once, and never its author", async ({ page, signIn, pageAs, apiAs, uniqueName }) => {
  await signIn(page, "amelia");
  await openBoard(page, "Platform Delivery");
  const api = await apiAs("amelia");
  const marcusApi = await apiAs("marcus");
  const boardId = await boardIdOf(page, "Platform Delivery");
  const { lists } = await json<{ lists: { id: string; name: string }[] }>(await api.get(`/api/boards/${boardId}?includeCards=false`));
  const listId = (lists.find((list) => list.name === "Backlog") ?? lists[0]!).id;
  const me = await json<{ id?: string; user?: { id: string } }>(await marcusApi.get("/api/me"));
  const marcusId = me.user?.id ?? me.id!;
  const monday = planningMonday();

  // Blocker Mon–Wed; two cards for Marcus on Thu–Fri. Only the first waits on the blocker so far.
  const blocker = await scheduledCard(api, boardId, listId, uniqueName("E2E conflict blocker"), day(monday, 0), day(monday, 2));
  const waiting = await scheduledCard(api, boardId, listId, uniqueName("E2E conflict waiting"), day(monday, 3), day(monday, 4));
  const later = await scheduledCard(api, boardId, listId, uniqueName("E2E conflict later"), day(monday, 3), day(monday, 4));
  try {
    for (const card of [waiting, later]) expect((await api.put(`/api/cards/${card.id}/assignees`, { data: { userIds: [marcusId] } })).ok()).toBe(true);
    const linked = await api.post(`/api/cards/${waiting.id}/relations`, { data: { targetCardId: blocker.id, direction: "blocked_by" } });
    expect(linked.status(), await linked.text()).toBe(201);

    // Marcus has his inbox open.
    const assignee = await pageAs("marcus");
    await openBoard(assignee, "Platform Delivery");
    await assignee.getByRole("button", { name: /^Notifications/ }).click();
    const notice = (card: CreatedCard) => assignee.locator(".notif-item")
      .filter({ hasText: "flagged that this card is planned to start before its blocker finishes" })
      .filter({ hasText: card.title });

    // Amelia slips the blocker to Friday, past the waiting card's Thursday start.
    expect((await api.patch(`/api/cards/${blocker.id}`, { data: { dueDateLocalDate: day(monday, 4) } })).ok()).toBe(true);
    await expect(notice(waiting)).toBeVisible({ timeout: 30_000 });
    await expect(notice(waiting)).toContainText(blocker.key);
    await assignee.screenshot({ path: test.info().outputPath("conflict-notification.png") });

    // Still in conflict after another slip: no second notice. A later, separate conflict on the
    // same board proves the recheck covering this slip has already run.
    expect((await api.patch(`/api/cards/${blocker.id}`, { data: { dueDateLocalDate: day(monday, 7) } })).ok()).toBe(true);
    const laterLink = await api.post(`/api/cards/${later.id}/relations`, { data: { targetCardId: blocker.id, direction: "blocked_by" } });
    expect(laterLink.status(), await laterLink.text()).toBe(201);
    await expect(notice(later)).toBeVisible({ timeout: 30_000 });
    await expect(notice(waiting)).toHaveCount(1);
    expect(await conflictNotices(marcusApi, waiting.id)).toBe(1);

    // Amelia caused both conflicts and watches all three cards as their creator: she hears nothing.
    expect(await conflictNotices(api, waiting.id)).toBe(0);
    expect(await conflictNotices(api, later.id)).toBe(0);

    // The waiting card's feed records the conflict, without an actor, naming the blocker.
    await assignee.keyboard.press("Escape");
    await expectCardTileMounted(assignee, waiting.title);
    const detail = await openCard(assignee, waiting.title);
    await expect(detail.getByText(`Scheduling conflict: this card is planned to start before ${blocker.key} finishes`)).toBeVisible();
    await assignee.screenshot({ path: test.info().outputPath("conflict-activity.png") });
  } finally {
    for (const card of [waiting, later, blocker]) {
      expect((await api.patch(`/api/cards/${card.id}/archive`, { data: { archived: true } })).ok()).toBe(true);
    }
  }
});
