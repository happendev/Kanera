import type { ScheduleResponse } from "../packages/shared/src/dto/schedule";
import { expandCardSummary, type CompactCardSummary } from "../packages/shared/src/events";
import { expect, test } from "./support/fixtures";

type SeedCard = ReturnType<typeof expandCardSummary>;

// Read the actual seed, without creating substitute fixtures. This catches an empty demo, arbitrary
// dates manufacturing conflicts, completed cards dated months after shipping, and missing handoffs.
test("the seed demonstrates realistic timeline dates and dependency handoffs", async ({ page, apiAs, signIn }, testInfo) => {
  const api = await apiAs("amelia");
  const response = await api.get("/api/boards");
  expect(response.ok()).toBe(true);
  const boards = await response.json() as { id: string; name: string; workspaceId: string }[];
  const allCards: SeedCard[] = [];
  for (const board of boards) {
    const open = await api.post(`/api/boards/${board.id}/open?includeCompleted=true`);
    expect(open.ok(), await open.text()).toBe(true);
    allCards.push(...(await open.json() as { cards: CompactCardSummary[] }).cards.map(expandCardSummary));
    const completed = await api.get(`/api/boards/${board.id}/completed?limit=100`);
    expect(completed.ok()).toBe(true);
    allCards.push(...(await completed.json() as { cards: CompactCardSummary[] }).cards.map(expandCardSummary));
  }
  const cards = [...new Map(allCards.map((card) => [card.id, card])).values()];
  const card = (title: string) => {
    const found = cards.find((candidate) => candidate.title === title);
    expect(found, title).toBeTruthy();
    return found!;
  };
  const startOnly = card("Prepare tablet layout for board overview");
  expect(startOnly.startDateLocalDate).toBeTruthy();
  expect(startOnly.dueDateLocalDate ?? null).toBeNull();
  expect(startOnly.dueDateSlot ?? null).toBeNull();
  expect(startOnly.dueDateTimezone ?? null).toBeNull();
  const dueOnly = card("Backfill biometric auth telemetry");
  expect(dueOnly.startDateLocalDate ?? null).toBeNull();
  expect(dueOnly.dueDateLocalDate).toBeTruthy();
  const unscheduled = card("Prototype swipe actions for list cards");
  expect(unscheduled.startDateLocalDate ?? null).toBeNull();
  expect(unscheduled.dueDateLocalDate ?? null).toBeNull();

  let historicalBars = 0;
  for (const row of cards) {
    if (row.startDateLocalDate && row.dueDateLocalDate) {
      expect(row.startDateLocalDate <= row.dueDateLocalDate, row.title).toBe(true);
    }
    if (row.completedAt && row.dueDateLocalDate) {
      expect(row.startDateLocalDate, row.title).toBeTruthy();
      expect(row.startDateLocalDate! >= new Date(row.createdAt).toISOString().slice(0, 10), row.title).toBe(true);
      expect(row.dueDateLocalDate <= new Date(row.completedAt).toISOString().slice(0, 10), row.title).toBe(true);
      historicalBars++;
    }
  }
  expect(historicalBars).toBeGreaterThan(20);

  const schedules: ScheduleResponse[] = [];
  for (const boardName of ["Platform Delivery", "Autumn Campaign Launch"]) {
    const board = boards.find((candidate) => candidate.name === boardName)!;
    const scheduled = await api.post("/api/cards/schedule", { data: { workspaceId: board.workspaceId } });
    expect(scheduled.ok(), await scheduled.text()).toBe(true);
    schedules.push(await scheduled.json() as ScheduleResponse);
  }
  const development = schedules[0]!;
  const marketing = schedules[1]!;
  const qa = card("Run QA pass for onboarding with no existing workspaces");
  const cleanup = card("Retry orphaned attachment cleanup on startup");
  // The recording calendar now puts QA after cleanup rather than demonstrating a conflict.
  expect(development.cards.filter((row) => row.conflicts.length)).toEqual([]);
  expect(qa.startDateLocalDate! > cleanup.dueDateLocalDate!).toBe(true);
  expect(qa.blockedByCount).toBe(2);
  expect(marketing.summary.conflictCount).toBe(0);
  for (const title of ["Produce the launch-day explainer video", "Approve the campaign launch package", "Prepare autumn campaign launch"]) {
    expect(marketing.cards.find((row) => row.id === card(title).id)?.critical, title).toBe(true);
  }
  // A completed prerequisite retains its link but no longer blocks its successor.
  const guide = card("Refresh engineering branching guide");
  const rollback = card("Write migration rollback guide for customer imports");
  expect(guide.completedAt).toBeTruthy();
  expect(rollback.blockedByCount).toBe(0);
  const relations = await api.get(`/api/cards/${rollback.id}/relations`);
  expect(relations.ok()).toBe(true);
  expect(await relations.text()).toContain(guide.id);
  const ios = card("Investigate flaky due-date reminders on iOS");
  const push = card("Add push preference controls to mobile settings");
  expect(ios.boardId).not.toBe(push.boardId);
  expect(development.edges).toContainEqual(expect.objectContaining({ sourceCardId: ios.id, targetCardId: push.id }));
  expect(development.cards.find((row) => row.id === push.id)?.conflicts).toEqual([]);
  await testInfo.attach("seeded-schedules", { body: JSON.stringify(schedules, null, 2), contentType: "application/json" });

  await signIn(page, "amelia");
  await page.goto(`/b/${qa.boardId}?view=timeline`);
  const qaBar = page.locator(`.tl-row-card[data-card-id="${qa.id}"] .tl-bar`);
  await expect(qaBar).not.toHaveClass(/has-conflict/);
  await expect(page.locator(".tl-count.is-warning")).toHaveCount(0);
  await expect(page.locator(`.tl-wire-hit[aria-label="${qa.key} waits on ${cleanup.key}"]`)).toHaveCount(1);
  await qaBar.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("seed-timeline-handoff-desktop.png") });

  const launch = card("Prepare autumn campaign launch");
  await page.goto(`/b/${launch.boardId}?view=timeline`);
  await page.getByRole("button", { name: "Critical path", exact: true }).click();
  await expect(page.locator(`.tl-row-card[data-card-id="${launch.id}"] .tl-bar`)).toHaveClass(/is-critical/);
  await page.screenshot({ path: testInfo.outputPath("seed-timeline-campaign-desktop.png") });

  await page.goto(`/b/${startOnly.boardId}?view=timeline`);
  const search = page.getByRole("searchbox", { name: "Search cards", exact: true });
  await search.fill(startOnly.title);
  await expect(page.locator(".tl-row-card")).toHaveCount(1);
  await expect(page.locator(`.tl-row-card[data-card-id="${startOnly.id}"] .tl-bar`)).toHaveAttribute("aria-label", /1 working day/);
  await search.fill(dueOnly.title);
  await expect(page.locator(".tl-row-card")).toHaveCount(1);
  await expect(page.locator(`.tl-row-card[data-card-id="${dueOnly.id}"] .tl-bar`)).toHaveAttribute("aria-label", /1 working day/);
  await search.fill(unscheduled.title);
  await expect(page.locator(".tl-row-card")).toHaveCount(1);
  await expect(page.locator(".tl-row-group.is-unscheduled")).toContainText("Unscheduled");
  await expect(page.locator(`.tl-row-card[data-card-id="${unscheduled.id}"] .tl-bar`)).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 900 });
  await search.fill("tablet layout");
  await expect(page.locator(".tl-row-card")).toHaveCount(1);
  const startBar = page.locator(`.tl-row-card[data-card-id="${startOnly.id}"] .tl-bar`);
  await startBar.scrollIntoViewIfNeeded();
  await expect(startBar).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("seed-timeline-start-only-phone.png") });
});
