import type { WorkDoneResponse } from "../packages/shared/src/dto/work-done";
import { expandCardSummary, type CompactCardSummary } from "../packages/shared/src/events";
import { expect, test } from "./support/fixtures";

// Detect a fresh seed losing its five-day delivery example or jitter reversing adjacent moves.
test("the seed provides a full delivery week with ordered movement and completed work", async ({ page, apiAs, signIn }, testInfo) => {
  const api = await apiAs("amelia");
  const boardsResponse = await api.get("/api/boards");
  expect(boardsResponse.ok()).toBe(true);
  const boards = await boardsResponse.json() as { id: string; name: string }[];
  const board = boards.find(board => board.name === "Autumn Campaign Launch")!;
  const openedResponse = await api.post(`/api/boards/${board.id}/open?includeCompleted=true`);
  expect(openedResponse.ok()).toBe(true);
  const opened = await openedResponse.json() as { cards: CompactCardSummary[]; lists: { id: string; name: string }[] };
  const anchor = opened.cards.map(expandCardSummary).find(card => card.title === "Creative concept directions presented")!;
  expect(anchor.completedAt).toBeTruthy();
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });
  const end = date.format(new Date(anchor.completedAt!));
  const start = new Date(`${end}T12:00:00Z`);
  expect(start.getUTCDay()).toBe(5);
  start.setUTCDate(start.getUTCDate() - 4);
  const startDate = start.toISOString().slice(0, 10);
  const after = new Date(`${end}T00:00:00Z`);
  after.setUTCDate(after.getUTCDate() + 1);
  const query = new URLSearchParams({ from: `${startDate}T00:00:00Z`, to: after.toISOString(), timeZone: "Europe/London" });
  const response = await api.get(`/api/boards/${board.id}/work-done?${query}`);
  expect(response.ok()).toBe(true);
  const { events } = await response.json() as WorkDoneResponse;
  const completed = events.filter(event => event.type === "completed");
  expect(completed).toHaveLength(5);
  expect(new Set(completed.map(event => date.format(new Date(event.at)))).size).toBe(5);
  expect(events.length).toBeGreaterThanOrEqual(10);
  expect(new Set(events.map(event => event.type))).toEqual(new Set(["completed", "moved", "checklistItemCompleted"]));
  expect(new Set(events.filter(event => "actorUserId" in event).map(event => event.actorUserId)).size).toBeGreaterThanOrEqual(3);
  const flow = ["Ideas & Requests", "Ready to Start", "In Progress", "Review & Approval", "Done"];
  for (const event of events) {
    expect(new Date(event.at).getUTCDay()).not.toBe(0);
    expect(new Date(event.at).getUTCDay()).not.toBe(6);
    if (event.type !== "moved") continue;
    const path = event.listPath.map(id => flow.indexOf(opened.lists.find(list => list.id === id)!.name));
    expect(path, `${event.card.title}: workflow order`).toEqual([...path].sort((a, b) => a - b));
  }
  await testInfo.attach("seed-delivery-week", { body: JSON.stringify({ start: startDate, end, events }, null, 2), contentType: "application/json" });

  await signIn(page, "amelia", `/b/${board.id}?view=history`);
  const view = page.locator("k-work-done-view");
  await expect(view).toBeVisible();
  await page.getByRole("group", { name: "Work done layout", exact: true }).getByRole("button", { name: "List", exact: true }).click();
  const labels = await page.evaluate(({ start, end }) => {
    const formatter = new Intl.DateTimeFormat(document.documentElement.lang || "en-US", {
      weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    });
    return { start: formatter.format(new Date(`${start}T12:00:00Z`)), end: formatter.format(new Date(`${end}T12:00:00Z`)) };
  }, { start: startDate, end });
  const selectRange = async () => {
    await view.getByRole("button", { name: "Pick a period", exact: true }).click();
    const picker = view.locator("k-date-range-picker");
    await expect(picker.getByRole("grid")).toBeVisible();
    const first = picker.getByRole("button", { name: labels.start, exact: true });
    if (!(await first.count())) await picker.getByRole("button", { name: "Previous month", exact: true }).click();
    await first.click();
    await picker.getByRole("button", { name: labels.end, exact: true }).click();
    await picker.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(picker).toBeHidden();
  };
  await selectRange();
  await expect(view.locator(".wd-verb--completed")).toHaveCount(5);
  await expect(view.locator(".wd-day-date")).toHaveCount(5);
  await page.screenshot({ path: testInfo.outputPath("delivery-week-list-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(view.locator(".wd-verb--completed")).toHaveCount(5);
  await page.screenshot({ path: testInfo.outputPath("delivery-week-list-phone.png") });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("group", { name: "Work done layout", exact: true }).getByRole("button", { name: "Report", exact: true }).click();
  await selectRange();
  await expect(view.locator(".rp-headline")).toContainText("completed 5 cards");
  await expect(view.locator(".rp-col")).toHaveCount(5);
  await page.screenshot({ path: testInfo.outputPath("delivery-week-report-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(view.locator(".rp-headline")).toContainText("completed 5 cards");
  await page.screenshot({ path: testInfo.outputPath("delivery-week-report-phone.png") });
});
