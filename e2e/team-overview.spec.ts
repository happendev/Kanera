import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { boardHref } from "./support/ui";

// Team Cards → Team overview: a manager (Amelia, owner) reads what a teammate (Marcus) is working
// on and what is next for him, from in-progress lists, his own activity, his queue and his other
// assigned cards, and drills into one set of his cards from the panel's stats.

type BoardLists = { boardId: string; lists: Map<string, string> };

async function platformDelivery(page: Page, api: APIRequestContext): Promise<BoardLists> {
  const boardId = (await boardHref(page, "Platform Delivery")).split("/")[2]!;
  const response = await api.get(`/api/boards/${boardId}?includeCards=false`);
  const { lists } = (await response.json()) as { lists: { id: string; name: string }[] };
  return { boardId, lists: new Map(lists.map((list) => [list.name, list.id])) };
}

async function userId(api: APIRequestContext): Promise<string> {
  const me = await api.get("/api/me");
  expect(me.ok(), await me.text()).toBe(true);
  const body = (await me.json()) as { id?: string; user?: { id: string } };
  return body.user?.id ?? body.id!;
}

async function createCard(api: APIRequestContext, board: BoardLists, title: string, assigneeIds: string[]): Promise<string> {
  const created = await api.post(`/api/boards/${board.boardId}/lists/${board.lists.get("Backlog")}/cards`, { data: { title, assigneeIds } });
  expect(created.ok(), await created.text()).toBe(true);
  return ((await created.json()) as { id: string }).id;
}

async function moveToList(api: APIRequestContext, cardId: string, listId: string) {
  // `afterCardId: null` is the head of the destination list.
  const moved = await api.post(`/api/cards/${cardId}/move`, { data: { listId, afterCardId: null } });
  expect(moved.ok(), await moved.text()).toBe(true);
}

function personPanel(page: Page, name: string): Locator {
  return page.locator("k-team-overview section.person").filter({ has: page.locator(".person-name", { hasText: name }) });
}

function section(panel: Locator, title: "In progress" | "Recently active" | "Up next" | "Assigned" | "Recently done"): Locator {
  return panel.locator(".section").filter({ has: panel.page().locator(".section-title", { hasText: title }) });
}

function stat(panel: Locator, label: "Open" | "In progress" | "Overdue" | "Done 7d"): Locator {
  return panel.locator(".person-stats button.stat").filter({ has: panel.page().locator(".stat-label", { hasText: label }) });
}

function row(scope: Locator, title: string): Locator {
  return scope.locator("button.row").filter({ has: scope.page().locator(".row-title", { hasText: title }) });
}

test("Team overview shows each teammate's in-progress work, own activity, queue and agenda, live", async ({ page, signIn, apiAs, uniqueName }) => {
  const amelia = await apiAs("amelia");
  const marcus = await apiAs("marcus");
  await signIn(page, "amelia");
  const board = await platformDelivery(page, amelia);
  const marcusId = await userId(marcus);
  // "In Progress" is an in-progress list in the seeded Development Team workflow; "Ready for QA" is not.
  const inProgress = board.lists.get("In Progress")!;
  const readyForQa = board.lists.get("Ready for QA")!;

  const workedOn = uniqueName("E2E overview started by Marcus");
  const triaged = uniqueName("E2E overview started by manager");
  const handedOff = uniqueName("E2E overview handed off by Marcus");
  const managerHandoff = uniqueName("E2E overview handed off by manager");
  const queued = uniqueName("E2E overview queued");
  const overdue = uniqueName("E2E overview overdue");
  const shipped = uniqueName("E2E overview shipped");
  const live = uniqueName("E2E overview live move");
  const unowned = uniqueName("E2E overview nobody owns");
  // Every title above shares uniqueName's per-test suffix. Searching for it narrows the overview's
  // card-derived sections to this test's cards, clear of Marcus's seeded long-running work.
  const suffix = workedOn.split(" ").at(-1)!;

  const workedOnId = await createCard(amelia, board, workedOn, [marcusId]);
  const triagedId = await createCard(amelia, board, triaged, [marcusId]);
  const handedOffId = await createCard(amelia, board, handedOff, [marcusId]);
  const managerHandoffId = await createCard(amelia, board, managerHandoff, [marcusId]);
  const queuedId = await createCard(amelia, board, queued, [marcusId]);
  const overdueId = await createCard(amelia, board, overdue, [marcusId]);
  const shippedId = await createCard(amelia, board, shipped, [marcusId]);
  const liveId = await createCard(amelia, board, live, [marcusId]);
  const unownedId = await createCard(amelia, board, unowned, []);

  // Marcus's own work: a card started, one handed off, a completion, and the head of his Up next.
  await moveToList(marcus, workedOnId, inProgress);
  await moveToList(marcus, handedOffId, readyForQa);
  const completed = await marcus.patch(`/api/cards/${shippedId}/completion`, { data: { completed: true } });
  expect(completed.ok(), await completed.text()).toBe(true);
  const queuedResponse = await marcus.post(`/api/work/priorities/${marcusId}/cards`, { data: { cardId: queuedId, afterId: null } });
  expect(queuedResponse.ok(), await queuedResponse.text()).toBe(true);
  // The manager's moves: "in progress" is list state, so a card the manager started is still work
  // Marcus has in progress; but the manager's hand-off is the manager's activity, not Marcus's.
  await moveToList(amelia, triagedId, inProgress);
  await moveToList(amelia, managerHandoffId, readyForQa);
  // Started, but assigned to nobody: no teammate panel can show it.
  await moveToList(amelia, unownedId, inProgress);
  const dated = await amelia.patch(`/api/cards/${overdueId}`, { data: { dueDateLocalDate: "2020-01-06" } });
  expect(dated.ok(), await dated.text()).toBe(true);
  // Overdue *and* in progress: listed under "In progress", so it must carry its own due chip there.
  const overdueInProgress = await amelia.patch(`/api/cards/${workedOnId}`, { data: { dueDateLocalDate: "2020-01-07" } });
  expect(overdueInProgress.ok(), await overdueInProgress.text()).toBe(true);

  await page.goto("/team-cards");
  await page.getByRole("button", { name: "Team overview" }).click();
  await page.getByRole("searchbox", { name: "Search cards" }).fill(suffix);
  const panel = personPanel(page, "Marcus Cole");
  await expect(panel).toBeVisible();

  // Nothing but the stats between the header and the sections: no workflow stage bar.
  await expect(panel.locator(".stages, .stage-bar, .stage-legend")).toHaveCount(0);

  const inProgressSection = section(panel, "In progress");
  await expect(row(inProgressSection, workedOn).locator(".row-time.is-running")).toHaveText(/^\s*(<1|\d+)m\s*$/);
  await expect(row(inProgressSection, workedOn).locator(".row-context")).toContainText("In Progress");
  await expect(row(inProgressSection, triaged).locator(".row-time.is-running")).toBeVisible();
  await expect(stat(panel, "In progress")).toHaveClass(/\bis-active\b/);
  await expect(stat(panel, "In progress").locator(".stat-value")).toHaveText("2");

  const recent = section(panel, "Recently active");
  await expect(row(recent, handedOff).locator(".row-note")).toHaveText(/^Moved /);
  await expect(row(recent, handedOff).locator(".row-context")).toContainText("Ready for QA");
  await expect(row(recent, managerHandoff)).toHaveCount(0);
  // An in-progress card is not repeated under "Recently active" even though Marcus moved it.
  await expect(row(recent, workedOn)).toHaveCount(0);

  const upNext = section(panel, "Up next");
  await expect(row(upNext, queued).locator(".row-rank")).toHaveText("1");

  // "Assigned" (formerly "Coming up"): the rest of his open cards, soonest due first.
  const assigned = section(panel, "Assigned");
  await expect(row(assigned, overdue).locator(".row-due")).toHaveClass(/\boverdue\b/);
  // The overdue count names both cards: one under "Assigned", the other flagged where it is shown.
  await expect(stat(panel, "Overdue")).toHaveClass(/\bis-alert\b/);
  await expect(stat(panel, "Overdue").locator(".stat-value")).toHaveText("2");
  await expect(row(inProgressSection, workedOn).locator(".row-due.overdue")).toBeVisible();
  await expect(row(assigned, workedOn)).toHaveCount(0);

  // Chips sit on their own line under the board · list context, never beside the text.
  const chipBox = await row(inProgressSection, workedOn).locator(".row-due").boundingBox();
  const contextBox = await row(inProgressSection, workedOn).locator(".row-context").boundingBox();
  expect(chipBox!.y).toBeGreaterThanOrEqual(contextBox!.y + contextBox!.height - 1);

  await expect(row(section(panel, "Recently done"), shipped)).toBeVisible();

  // The stats are toggles: Overdue swaps the summary for every overdue card, and back again.
  await stat(panel, "Overdue").click();
  await expect(stat(panel, "Overdue")).toHaveAttribute("aria-pressed", "true");
  const drillDown = panel.locator(".section.drill-down");
  await expect(drillDown.locator(".section-title")).toContainText("Overdue");
  await expect(row(drillDown, overdue)).toBeVisible();
  await expect(row(drillDown, workedOn)).toBeVisible();
  await expect(row(drillDown, queued)).toHaveCount(0);
  await expect(section(panel, "Assigned")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("team-overview-overdue.png"), fullPage: true });
  await stat(panel, "Done 7d").click();
  await expect(row(drillDown, shipped)).toBeVisible();
  await stat(panel, "Done 7d").click();
  await expect(drillDown).toHaveCount(0);
  await expect(section(panel, "Assigned")).toBeVisible();

  // In-progress work nobody owns gets its own panel instead of disappearing.
  const unownedPanel = page.locator("k-team-overview section.unowned");
  await expect(row(unownedPanel, unowned).locator(".row-time.is-running")).toBeVisible();
  await expect(row(panel, unowned)).toHaveCount(0);

  // Realtime: Marcus starts another card while the overview is open, and it arrives without a reload.
  await moveToList(marcus, liveId, inProgress);
  await expect(row(inProgressSection, live).locator(".row-time.is-running")).toBeVisible();
  await expect(stat(panel, "In progress").locator(".stat-value")).toHaveText("3");
  await page.screenshot({ path: test.info().outputPath("team-overview.png"), fullPage: true });
  // Wide screens: never more than three panels to a row, so none gets compressed.
  await page.setViewportSize({ width: 2400, height: 1000 });
  const columns = await page.locator("k-team-overview .overview-grid").evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length);
  expect(columns).toBeLessThanOrEqual(3);
  await page.screenshot({ path: test.info().outputPath("team-overview-wide.png") });
  // Phone width: panels stack into one column without horizontal overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("team-overview-phone.png") });
  await page.setViewportSize({ width: 1440, height: 900 });

  // A row opens the card over the overview.
  await row(inProgressSection, workedOn).click();
  await expect(page.getByRole("dialog", { name: `Card detail: ${workedOn}` })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: `Card detail: ${workedOn}` })).toBeHidden();

  // The panel's open action lands on Marcus's own board, focused on him.
  await panel.getByRole("button", { name: "Open Marcus Cole’s cards" }).click();
  await expect(page.locator("section.workspace-board").first()).toBeVisible();
  await expect(page.locator("k-card").filter({ hasText: workedOn })).toHaveCount(1);
  await expect(page.locator("button.k-toolbar-trigger.is-set").filter({ hasText: "Marcus Cole" })).toBeVisible();
});
