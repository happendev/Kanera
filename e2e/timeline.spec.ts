import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { contextDefaults, users } from "./support/env";
import { boardIdOf, openBoard } from "./support/ui";

// The board Timeline (Gantt) view. One member drags bars and draws a dependency; a second member
// keeps the same view open and only ever learns about it through realtime, which is the part no
// unit test can exercise. Dates are chosen relative to today so the bars sit inside the first
// screen of the chart and the schedule's working-day arithmetic is the real one.

type CreatedCard = { id: string; key: string; title: string };

/** Pixels per calendar day at the Timeline's default (week) zoom; see timeline-layout.ts. */
const PX_PER_DAY = 16;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The Monday at least a week ahead of today, so no bar starts in the past or on a weekend. */
function nextPlanningMonday(): Date {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 7);
  while (date.getUTCDay() !== 1) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function plusDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

async function createScheduledCard(page: Page, api: APIRequestContext, title: string, start: Date, due: Date): Promise<CreatedCard> {
  const boardId = await boardIdOf(page, "Platform Delivery");
  const board = await api.get(`/api/boards/${boardId}?includeCards=false`);
  const { lists } = (await board.json()) as { lists: { id: string; name: string }[] };
  const backlog = lists.find((list) => list.name === "Backlog") ?? lists[0]!;
  const created = await api.post(`/api/boards/${boardId}/lists/${backlog.id}/cards`, {
    data: { title, atTop: true, startDateLocalDate: isoDate(start), dueDateLocalDate: isoDate(due) },
  });
  expect(created.ok(), await created.text()).toBe(true);
  return (await created.json()) as CreatedCard;
}

async function datesOf(api: APIRequestContext, boardId: string, cardId: string): Promise<{ start: string | null; due: string | null }> {
  const response = await api.post("/api/cards/dependency-graph", { data: { boardId } });
  expect(response.ok(), await response.text()).toBe(true);
  const { cards } = (await response.json()) as { cards: { id: string; startDateLocalDate: string | null; dueDateLocalDate: string | null }[] };
  const card = cards.find((candidate) => candidate.id === cardId);
  return { start: card?.startDateLocalDate ?? null, due: card?.dueDateLocalDate ?? null };
}

function wireBetween(page: Page, blocker: CreatedCard, dependent: CreatedCard) {
  return page.locator(`k-board-timeline-view .tl-wire-hit[aria-label="${dependent.key} waits on ${blocker.key}"]`);
}

function bar(page: Page, card: CreatedCard) {
  return page.locator(`k-board-timeline-view .tl-row-card[data-card-id="${card.id}"] .tl-bar`);
}

async function openTimeline(page: Page) {
  await page.getByRole("button", { name: "Timeline view", exact: true }).click();
  await expect(page).toHaveURL(/view=timeline/);
}

test("the timeline draws bars, reschedules by drag, flags conflicts and draws dependencies, live for a second member", async ({ page, signIn, pageAs, apiAs, uniqueName }) => {
  await signIn(page, "amelia");
  await openBoard(page, "Platform Delivery");
  const api = await apiAs("amelia");
  const boardId = await boardIdOf(page, "Platform Delivery");
  const monday = nextPlanningMonday();
  // first: Mon–Wed; second: Thu–Fri of the same week and waiting on first; third: the next Monday.
  const first = await createScheduledCard(page, api, uniqueName("E2E timeline first"), monday, plusDays(monday, 2));
  const second = await createScheduledCard(page, api, uniqueName("E2E timeline second"), plusDays(monday, 3), plusDays(monday, 4));
  const third = await createScheduledCard(page, api, uniqueName("E2E timeline third"), plusDays(monday, 7), plusDays(monday, 8));
  const created = [first, second, third];

  try {
    const link = await api.post(`/api/cards/${second.id}/relations`, { data: { targetCardId: first.id, direction: "blocked_by" } });
    expect(link.status(), await link.text()).toBe(201);
    // The seed workspace carries an "Issue / Bug" label; the first card wears it so the chart has a chip to show.
    const { board } = (await (await api.get(`/api/boards/${boardId}?includeCards=false`)).json()) as { board: { workspaceId: string } };
    const workspace = await api.get(`/api/workspaces/${board.workspaceId}`);
    const bugLabel = ((await workspace.json()) as { cardLabels: { id: string; name: string }[] }).cardLabels.find((label) => label.name === "Issue / Bug")!;
    expect(bugLabel, "seed label Issue / Bug").toBeTruthy();
    expect((await api.put(`/api/cards/${first.id}/labels`, { data: { labelIds: [bugLabel.id] } })).ok()).toBe(true);

    // A second member watches the same chart; nothing below reloads their page.
    const viewer = await pageAs("marcus");
    await openBoard(viewer, "Platform Delivery");
    await openTimeline(viewer);
    await expect(bar(viewer, first)).toBeVisible();
    const viewerBefore = (await bar(viewer, first).boundingBox())!;
    // The seed board has blocking links of its own, so wire counts are relative to what is there.
    const wires = viewer.locator("k-board-timeline-view .tl-wire-hit");
    await expect(wireBetween(viewer, first, second)).toHaveCount(1);
    const baselineWires = await wires.count();
    await expect(bar(viewer, second)).not.toHaveClass(/has-conflict/);

    await openTimeline(page);
    // A three-day bar is too short for inline text at week zoom; its name lives in the accessible label.
    await expect(bar(page, first)).toHaveAttribute("aria-label", new RegExp(`^${first.title}\\. .*3 working days`));
    // Labels are otherwise invisible on the chart: the row shows a chip and the bar names it for screen readers.
    const firstName = page.locator(`k-board-timeline-view .tl-row-card[data-card-id="${first.id}"] .tl-card-name`);
    await expect(firstName.locator("k-card-labels .label-chip")).toContainText(bugLabel.name);
    await expect(bar(page, first)).toHaveAttribute("aria-label", new RegExp(`^${first.title}\\. ${bugLabel.name}\\. `));
    await page.screenshot({ path: test.info().outputPath("timeline-desktop.png") });

    // Drag the first bar two days later. It keeps its working-day length, so Mon–Wed becomes
    // Wed–Fri, and its dependent (Thu–Fri) now starts before it finishes: a conflict.
    const box = (await bar(page, first).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + PX_PER_DAY, box.y + box.height / 2, { steps: 3 });
    await page.mouse.move(box.x + box.width / 2 + PX_PER_DAY * 2, box.y + box.height / 2, { steps: 3 });
    await page.mouse.up();
    await expect.poll(() => datesOf(api, boardId, first.id)).toEqual({ start: isoDate(plusDays(monday, 2)), due: isoDate(plusDays(monday, 4)) });
    await expect(page.locator("k-board-timeline-view .tl-count.is-warning")).toContainText(/scheduling conflict/);
    await expect(bar(page, second)).toHaveClass(/has-conflict/);

    // The other member's bar moved by the same two days, and their chart flags the conflict too.
    await expect.poll(async () => (await bar(viewer, first).boundingBox())!.x - viewerBefore.x).toBe(PX_PER_DAY * 2);
    await expect(bar(viewer, second)).toHaveClass(/has-conflict/);

    // Critical path: the chained cards light up, the unchained third stays plain.
    await page.getByRole("button", { name: "Critical path", exact: true }).click();
    await expect(bar(page, first)).toHaveClass(/is-critical/);
    await expect(bar(page, second)).toHaveClass(/is-critical/);
    await expect(bar(page, third)).not.toHaveClass(/is-critical/);
    // Filtering is presentation-only: hiding the blocker must retain its conflict and critical path.
    const search = page.getByRole("searchbox", { name: "Search cards", exact: true });
    await search.fill(second.title);
    await expect(bar(page, first)).toHaveCount(0);
    await expect(bar(page, second)).toHaveClass(/has-conflict/);
    await expect(bar(page, second)).toHaveClass(/is-critical/);
    await search.fill("");
    await page.getByRole("button", { name: "Critical path", exact: true }).click();

    // Keyboard activation uses the same click path as a tap and doesn't require a drag gesture.
    await bar(page, second).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("k-card-detail")).toContainText(second.title);
    await page.keyboard.press("Escape");
    await expect(page.locator("k-card-detail")).toHaveCount(0);

    // Draw a dependency: from the second bar's handle onto the third card's bar. Both rows are
    // brought on screen first; the pointer only finds a target it can actually hit.
    await bar(page, third).scrollIntoViewIfNeeded();
    await bar(page, second).scrollIntoViewIfNeeded();
    await bar(page, second).hover();
    const handle = page.locator(`k-board-timeline-view .tl-row-card[data-card-id="${second.id}"] .tl-link-handle`);
    const from = (await handle.boundingBox())!;
    const target = (await bar(page, third).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 6 });
    await expect(bar(page, third)).toHaveClass(/is-link-target/);
    await page.mouse.up();
    const newWire = wireBetween(page, second, third);
    await expect(newWire).toHaveCount(1);
    await expect(wires).toHaveCount(baselineWires + 1);

    // Selecting a wire offers to remove it; the other member's wire goes with it.
    await newWire.click();
    await page.getByRole("button", { name: "Remove dependency", exact: true }).click();
    await expect(newWire).toHaveCount(0);
    await expect(wires).toHaveCount(baselineWires);

    // A phone keeps the chart and the grouping, with the toolbar collapsed to icons.
    await viewer.setViewportSize({ width: 390, height: 900 });
    await expect(bar(viewer, first)).toBeVisible();
    await viewer.screenshot({ path: test.info().outputPath("timeline-phone.png") });
    await viewer.setViewportSize({ width: 1280, height: 900 });

    // A row name opens the card in the board's drawer.
    await page.locator(`k-board-timeline-view .tl-row-card[data-card-id="${third.id}"] .tl-card-name`).click();
    await expect(page.locator("k-card-detail")).toContainText(third.title);
  } finally {
    for (const card of created) {
      expect((await api.patch(`/api/cards/${card.id}/archive`, { data: { archived: true } })).ok()).toBe(true);
    }
  }
});

test("off-board constraints refresh live and observers can open bars with mouse, keyboard and touch", async ({ page, browser, runtimeGuard, signIn, pageAs, apiAs, uniqueName }) => {
  await signIn(page, "amelia");
  await openBoard(page, "Platform Delivery");
  const api = await apiAs("amelia");
  const existing = await boardIdOf(page, "Platform Delivery");
  const { board, lists } = await (await api.get(`/api/boards/${existing}?includeCards=false`)).json() as { board: { workspaceId: string }; lists: { id: string }[] };
  const createdBoards: string[] = [];
  const monday = nextPlanningMonday();
  try {
    for (const name of ["Timeline upstream", "Timeline dependent"]) {
      const response = await api.post(`/api/workspaces/${board.workspaceId}/boards`, { data: { name: uniqueName(name) } });
      expect(response.ok(), await response.text()).toBe(true);
      createdBoards.push(((await response.json()) as { id: string }).id);
    }
    const [upstream, downstream] = createdBoards;
    const create = async (boardId: string, name: string, offset: number) => {
      const response = await api.post(`/api/boards/${boardId}/lists/${lists[0]!.id}/cards`, { data: { title: uniqueName(name), startDateLocalDate: isoDate(plusDays(monday, offset)), dueDateLocalDate: isoDate(plusDays(monday, offset + 1)) } });
      expect(response.ok(), await response.text()).toBe(true);
      return await response.json() as CreatedCard;
    };
    const blocker = await create(upstream!, "External blocker", 0);
    const dependent = await create(downstream!, "Dependent", 3);
    expect((await api.post(`/api/cards/${blocker.id}/relations`, { data: { targetCardId: dependent.id, direction: "blocks" } })).ok()).toBe(true);
    const viewer = await pageAs("marcus");
    await viewer.goto(`/b/${downstream}?view=timeline`);
    await expect(bar(viewer, dependent)).toBeVisible();
    await expect(bar(viewer, dependent)).not.toHaveClass(/has-conflict/);
    // Wait for the external graph read/room join before sending a change on that other board.
    await viewer.getByRole("button", { name: "Critical path", exact: true }).click();
    await expect(bar(viewer, dependent)).toHaveClass(/is-critical/);
    expect((await api.patch(`/api/cards/${blocker.id}`, { data: { dueDateLocalDate: isoDate(plusDays(monday, 4)) } })).ok()).toBe(true);
    await expect(bar(viewer, dependent)).toHaveClass(/has-conflict/);
    expect((await api.patch(`/api/cards/${blocker.id}`, { data: { dueDateLocalDate: isoDate(plusDays(monday, 1)) } })).ok()).toBe(true);
    await expect(bar(viewer, dependent)).not.toHaveClass(/has-conflict/);

    expect((await api.post(`/api/workspaces/${board.workspaceId}/guests/invitations`, { data: { boardId: downstream, email: users.maya.email, role: "observer" } })).ok()).toBe(true);
    const observer = await pageAs("maya");
    await observer.goto(`/b/${downstream}?view=timeline`);
    await expect(bar(observer, dependent)).toBeVisible();
    await expect(bar(observer, dependent).locator(".tl-handle")).toHaveCount(0);
    await bar(observer, dependent).click();
    await expect(observer.locator("k-card-detail")).toContainText(dependent.title);
    await observer.keyboard.press("Escape");
    await expect(observer.locator("k-card-detail")).toHaveCount(0);
    await bar(observer, dependent).focus();
    await observer.keyboard.press("Space");
    await expect(observer.locator("k-card-detail")).toContainText(dependent.title);

    const touch = await browser.newContext({ ...contextDefaults, hasTouch: true, viewport: { width: 390, height: 844 } });
    runtimeGuard.watchContext(touch, "touch observer");
    try {
      const phone = await touch.newPage();
      await signIn(phone, "maya");
      await phone.goto(`/b/${downstream}?view=timeline`);
      await expect(bar(phone, dependent)).toBeVisible();
      expect(await phone.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      await bar(phone, dependent).scrollIntoViewIfNeeded();
      await phone.screenshot({ path: test.info().outputPath("timeline-touch.png") });
      await bar(phone, dependent).tap();
      await expect(phone.locator("k-card-detail")).toContainText(dependent.title);
    } finally { await touch.close(); }
  } finally {
    for (const id of createdBoards.reverse()) expect((await api.delete(`/api/boards/${id}`)).ok()).toBe(true);
  }
});

test("large timelines window rows while preserving scrolling and filters", async ({ page, signIn, apiAs, uniqueName }) => {
  await signIn(page, "amelia");
  await openBoard(page, "Platform Delivery");
  const api = await apiAs("amelia");
  const boardId = await boardIdOf(page, "Platform Delivery");
  const monday = nextPlanningMonday();
  const prototype = await createScheduledCard(page, api, uniqueName("Virtual row"), monday, plusDays(monday, 4));
  // Only the board-open response is enlarged. Real endpoints and normal Angular inputs render it;
  // no dev-mode component mutation or database fixture volume obscures the UI measurement.
  let count = 100;
  await page.route(`**/api/boards/${boardId}/open*`, async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { cards: { id: string; title: string; position: string }[] };
    const source = body.cards.find((card) => card.id === prototype.id)!;
    expect(source).toBeTruthy();
    body.cards = Array.from({ length: count }, (_, index) => ({ ...source, id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, title: `Scale row ${String(index).padStart(4, "0")}`, position: String((index + 1) * 1000) }));
    await route.fulfill({ response, json: body });
  });
  const metrics: object[] = [];
  try {
    for (count of [100, 400, 1000, 2000]) {
      await page.goto(`/b/${boardId}?view=timeline`);
      await expect(page.locator(".tl-count").first()).toContainText(`${count.toLocaleString("en-GB")} of ${count}`);
      const mounted = await page.locator(".tl-row-card").count();
      expect(mounted).toBeLessThan(80);
      const toggle = page.getByRole("button", { name: "Critical path", exact: true });
      const elapsed = await toggle.evaluate(async (button: HTMLButtonElement) => {
        const started = performance.now();
        button.click();
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        return performance.now() - started;
      });
      metrics.push({ count, mountedRows: mounted, toggleMs: Math.round(elapsed), domNodes: await page.locator("k-board-timeline-view *").count() });
      await page.locator(".tl-scroller").evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(page.locator(".tl-card-name").filter({ hasText: `Scale row ${String(count - 1).padStart(4, "0")}` })).toBeVisible();
      expect(await page.locator(".tl-row-card").count()).toBeLessThan(80);
    }
    await page.screenshot({ path: test.info().outputPath("timeline-2000-rows.png") });
    const search = page.getByRole("searchbox", { name: "Search cards", exact: true });
    await search.fill("Scale row 1999");
    await expect(page.locator(".tl-row-card")).toHaveCount(1);
    await expect(page.locator(".tl-card-name")).toContainText("Scale row 1999");
    await test.info().attach("timeline-performance.json", { body: JSON.stringify(metrics, null, 2), contentType: "application/json" });
  } finally {
    await page.unroute(`**/api/boards/${boardId}/open*`);
    expect((await api.patch(`/api/cards/${prototype.id}/archive`, { data: { archived: true } })).ok()).toBe(true);
  }
});

test("the chart zooms around the pointer with ctrl+wheel and the buttons, and pans by dragging its background", async ({ page, signIn, apiAs, uniqueName }) => {
  await signIn(page, "amelia");
  await openBoard(page, "Platform Delivery");
  const api = await apiAs("amelia");
  const monday = nextPlanningMonday();
  const card = await createScheduledCard(page, api, uniqueName("E2E timeline zoom"), monday, plusDays(monday, 4));
  try {
    await openTimeline(page);
    const target = bar(page, card);
    await target.scrollIntoViewIfNeeded();
    const before = (await target.boundingBox())!;
    const pageScale = () => page.evaluate(() => window.visualViewport?.scale ?? 1);
    const scaleBefore = await pageScale();

    // Ctrl + wheel zooms the chart, not the page, and the day under the pointer stays put.
    const anchorX = before.x + 2;
    await page.mouse.move(anchorX, before.y + before.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -300);
    await page.keyboard.up("Control");
    await expect.poll(async () => (await target.boundingBox())!.width).toBeGreaterThan(before.width * 1.5);
    const zoomed = (await target.boundingBox())!;
    expect(Math.abs(zoomed.x - before.x)).toBeLessThan(4);
    expect(await pageScale()).toBe(scaleBefore);

    // The buttons step the same scale back out.
    await page.getByRole("button", { name: "Zoom out", exact: true }).click();
    await expect.poll(async () => (await target.boundingBox())!.width).toBeLessThan(zoomed.width * 0.75);
    // The zoom eases over a few frames, moving the scroll with it; let it come to rest.
    await expect.poll(() => target.evaluate(async (element) => {
      const width = element.getBoundingClientRect().width;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return element.getBoundingClientRect().width === width;
    })).toBe(true);

    // Grabbing the empty chart and dragging left scrolls it right by the same distance.
    const scroller = page.locator("k-board-timeline-view .tl-scroller");
    const scrollBefore = await scroller.evaluate((element) => element.scrollLeft);
    const lane = (await page.locator(`k-board-timeline-view .tl-row-card[data-card-id="${card.id}"] .tl-card-lane`).boundingBox())!;
    const now = (await target.boundingBox())!;
    const grabX = Math.min(now.x + now.width + 240, (page.viewportSize()?.width ?? 1280) - 40);
    const grabY = lane.y + lane.height / 2;
    await page.mouse.move(grabX, grabY);
    await page.mouse.down();
    await page.mouse.move(grabX - 150, grabY, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBe(scrollBefore + 150);
    // The release is not a click: nothing opened.
    await expect(page.locator("k-card-detail")).toHaveCount(0);

    // Zoomed right in, most of the plan is off screen; Fit brings every scheduled bar into the chart.
    const slider = page.getByRole("slider", { name: "Zoom", exact: true });
    // fill() rejects the slider's long log-scale max, so set it as a drag to the end would.
    await slider.evaluate((input: HTMLInputElement) => {
      input.value = input.max;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(page.getByRole("button", { name: "Zoom in", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Fit all", exact: true }).click();
    const chartBounds = async () => {
      const pane = (await page.locator("k-board-timeline-view .tl-corner").boundingBox())!;
      const view = (await scroller.boundingBox())!;
      const bars = await page.locator("k-board-timeline-view .tl-bar").evaluateAll((elements) => elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right };
      }));
      return bars.every((box) => box.left >= pane.x + pane.width - 1 && box.right <= view.x + view.width + 1);
    };
    await expect.poll(chartBounds, { timeout: 5000 }).toBe(true);
  } finally {
    expect((await api.patch(`/api/cards/${card.id}/archive`, { data: { archived: true } })).ok()).toBe(true);
  }
});
