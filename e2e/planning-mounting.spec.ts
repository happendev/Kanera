import { expect, test } from "./support/fixtures";

// These need a real layout engine: viewport width versus panel width, scroll clipping, focus,
// and the CDK drop registry cannot be established by the DOM-less component tests.
test("calendar measures before mounting and keeps crowded days expandable and droppable", async ({ page, apiAs, testWorkspace, signIn }) => {
  const api = await apiAs("amelia");
  const listId = testWorkspace.lists.values().next().value!;
  const teammate = await (await (await apiAs("priya")).get("/api/me")).json() as { id: string };
  const today = new Date();
  const date = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-01`;
  for (let i = 0; i < 36; i++) {
    const response = await api.post(`/api/boards/${testWorkspace.boardId}/lists/${listId}/cards`, { data: { title: `Crowded day ${i}`, dueDateLocalDate: date, dueDateSlot: "anyTime" } });
    expect(response.ok()).toBe(true);
    const card = await response.json() as { id: string };
    expect((await api.put(`/api/cards/${card.id}/assignees`, { data: { userIds: [teammate.id] } })).ok()).toBe(true);
  }
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.addInitScript(() => {
    const state = window as unknown as { calendarPeak: number };
    state.calendarPeak = 0;
    new MutationObserver(() => {
      state.calendarPeak = Math.max(state.calendarPeak, document.querySelectorAll("k-board-calendar-view .cal-card").length);
    }).observe(document, { childList: true, subtree: true });
  });
  await signIn(page, "amelia", `/b/${testWorkspace.boardId}?view=calendar`);
  const calendar = page.locator("k-board-calendar-view");
  await expect(calendar.locator(".cal-card")).toHaveCount(2);
  expect(await page.evaluate(() => (window as unknown as { calendarPeak: number }).calendarPeak)).toBe(2);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(calendar.locator(".cal-card")).toHaveCount(4);
  await calendar.getByRole("button", { name: "+32 more", exact: true }).click();
  await expect(calendar.locator(".cal-card")).toHaveCount(36);
  await calendar.getByRole("button", { name: "Show less", exact: true }).click();
  await expect(calendar.locator(".cal-card")).toHaveCount(4);
  await page.screenshot({ path: test.info().outputPath("calendar-bounded-desktop.png") });

  // Capping tiles must leave the empty-day drop lists registered.
  const source = calendar.locator(".cal-card").first();
  const title = (await source.locator(".cal-card-title-text").textContent())!;
  const target = calendar.locator(".calendar-slot-empty .day-cards").first();
  await source.scrollIntoViewIfNeeded();
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + 30, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(30, to.height / 2), { steps: 10 });
  await page.mouse.up();
  await expect(calendar.locator(".calendar-slot-empty").filter({ hasText: title })).toHaveCount(0);
  await expect(calendar.locator(".calendar-day").filter({ hasText: title }).locator(".cal-card")).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 900 });
  // A phone agenda uses the same expansion controls with a larger, readable day limit.
  await calendar.locator(".cal-mini-day:not(.is-muted)").filter({ has: page.locator(".cal-mini-number", { hasText: /^1$/ }) }).click();
  await expect(calendar.locator(".cal-card")).toHaveCount(19);
  await calendar.getByRole("button", { name: /more$/ }).click();
  await expect(calendar.locator(".cal-card")).toHaveCount(35);
  await page.screenshot({ path: test.info().outputPath("calendar-expanded-phone.png") });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/team-cards");
  await page.getByRole("button", { name: "Calendar view", exact: true }).click();
  await expect(calendar.locator(".cal-card")).toHaveCount(5);
  await calendar.getByRole("button", { name: "+31 more", exact: true }).click();
  await expect(calendar.locator(".cal-card")).toHaveCount(36);
});

test("dependency chains mount near the viewport, remount on scroll and preserve keyboard focus", async ({ page, apiAs, testWorkspace, signIn }) => {
  const api = await apiAs("amelia");
  const listId = testWorkspace.lists.values().next().value!;
  const teammate = await (await (await apiAs("priya")).get("/api/me")).json() as { id: string };
  for (let i = 0; i < 45; i++) {
    const ids: string[] = [];
    for (const suffix of ["start", "finish"]) {
      const response = await api.post(`/api/boards/${testWorkspace.boardId}/lists/${listId}/cards`, { data: { title: `Chain ${String(i).padStart(2, "0")} ${suffix}` } });
      expect(response.ok()).toBe(true);
      const card = await response.json() as { id: string };
      ids.push(card.id);
      expect((await api.put(`/api/cards/${card.id}/assignees`, { data: { userIds: [teammate.id] } })).ok()).toBe(true);
    }
    expect((await api.post(`/api/cards/${ids[1]}/relations`, { data: { targetCardId: ids[0], direction: "blocked_by" } })).ok()).toBe(true);
  }
  await signIn(page, "amelia", `/b/${testWorkspace.boardId}?view=dependencies`);
  const map = page.locator("k-dependency-map");
  const chains = map.locator(".dm-chain");
  await expect(chains).toHaveCount(45);
  await expect(map.locator(".dm-tile").first()).toBeVisible();
  await expect.poll(() => map.locator(".dm-tile").count()).toBeLessThan(90);
  const first = chains.first();
  const firstCard = first.locator(".dm-tile").first();
  await page.setViewportSize({ width: 390, height: 900 });
  const horizontal = first.locator(".dm-scroll");
  await horizontal.evaluate((el) => { el.scrollLeft = 80; });
  const horizontalOffset = await horizontal.evaluate((el) => el.scrollLeft);
  expect(horizontalOffset).toBeGreaterThan(0);
  await firstCard.focus();
  await map.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(firstCard).toBeFocused();
  await expect(first).toHaveAttribute("data-viewport-mounted", "true");
  await page.getByRole("button", { name: "Dependencies view", exact: true }).evaluate((el) => el.focus({ preventScroll: true }));
  await expect(first).toHaveAttribute("data-viewport-mounted", "false");
  await chains.last().scrollIntoViewIfNeeded();
  await expect(chains.last().locator(".dm-tile")).toHaveCount(2);
  await expect.poll(() => map.locator(".dm-tile").count()).toBeLessThan(90);
  await chains.first().scrollIntoViewIfNeeded();
  await expect(first.locator(".dm-tile")).toHaveCount(2);
  await expect.poll(() => first.locator(".dm-scroll").evaluate((el) => el.scrollLeft)).toBe(horizontalOffset);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.screenshot({ path: test.info().outputPath("dependencies-windowed-desktop.png") });

  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole("group", { name: "Dependencies layout", exact: true }).getByRole("button", { name: "Steps", exact: true }).click();
  await expect(first.locator(".dm-row")).toHaveCount(2);
  await expect.poll(() => map.locator(".dm-row").count()).toBeLessThan(90);
  await chains.last().scrollIntoViewIfNeeded();
  await expect(chains.last().locator(".dm-row")).toHaveCount(2);
  await chains.last().locator(".dm-row").first().click();
  await expect(page.locator("k-card-detail")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("dependencies-windowed-phone.png") });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/team-cards");
  await page.getByRole("button", { name: "Dependencies view", exact: true }).click();
  await expect(chains).toHaveCount(45);
  await expect(map.locator(".dm-tile").first()).toBeVisible();
  await chains.last().scrollIntoViewIfNeeded();
  await expect(chains.last().locator(".dm-tile")).toHaveCount(2);
  await expect(chains.first()).toHaveAttribute("data-viewport-mounted", "false");
  await expect.poll(() => map.locator(".dm-tile").count()).toBeLessThan(90);
});
