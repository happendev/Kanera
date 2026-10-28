import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./support/scenario";
import { contextDefaults, users } from "./support/env";
import { boardIdOf, openBoard } from "./support/ui";

// The board Timeline (Gantt) view. One member drags bars and draws a dependency; a second member
// keeps the same view open and only ever learns about it through realtime, which is the part no
// unit test can exercise. Dates are chosen relative to today so the bars sit inside the first
// screen of the chart and the schedule's working-day arithmetic is the real one.

type CreatedCard = { id: string; key: string; title: string };


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
  const boardId = await boardIdOf(page, "E2E primary board");
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

test("timeline Hide completed stays in sync with Filter and reacts to completion live", async ({ page, signIn, apiAs, uniqueName }) => {
  await signIn(page, "amelia");
  await openBoard(page, "E2E primary board");
  const api = await apiAs("amelia");
  const monday = nextPlanningMonday();
  const prefix = uniqueName("E2E timeline completion");
  const active = await createScheduledCard(page, api, `${prefix} active`, monday, plusDays(monday, 2));
  const done = await createScheduledCard(page, api, `${prefix} done`, monday, plusDays(monday, 2));
  const undated = await createScheduledCard(page, api, `${prefix} undated`, monday, monday);
  try {
    expect((await api.patch(`/api/cards/${undated.id}`, { data: { startDateLocalDate: null, dueDateLocalDate: null } })).ok()).toBe(true);
    for (const card of [done, undated]) {
      expect((await api.patch(`/api/cards/${card.id}/completion`, { data: { completed: true } })).ok()).toBe(true);
    }
    await openTimeline(page);
    await page.getByRole("searchbox", { name: "Search cards", exact: true }).fill(prefix);
    const timeline = page.locator("k-board-timeline-view");
    const toggle = timeline.getByRole("button", { name: "Hide completed", exact: true });
    const row = (id: string) => timeline.locator(`.tl-row-card[data-card-id="${id}"]`);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(bar(page, done)).toBeVisible();
    await expect(row(undated.id)).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(bar(page, active)).toBeVisible();
    await expect(row(done.id)).toHaveCount(0);
    await expect(row(undated.id)).toHaveCount(0);
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("searchbox", { name: "Search cards", exact: true }).fill(prefix);
    await expect(bar(page, active)).toBeVisible();
    await expect(row(done.id)).toHaveCount(0);
    await expect(timeline.locator(".tl-row-card")).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath("timeline-hide-completed-desktop.png") });

    // A completion elsewhere must remove its row without reloading; reopening brings it back.
    expect((await api.patch(`/api/cards/${active.id}/completion`, { data: { completed: true } })).ok()).toBe(true);
    await expect(row(active.id)).toHaveCount(0);
    expect((await api.patch(`/api/cards/${active.id}/completion`, { data: { completed: false } })).ok()).toBe(true);
    await expect(bar(page, active)).toBeVisible();

    const filter = page.locator("k-filter-bar");
    await filter.getByRole("button", { name: /^Filter/ }).click();
    await expect(page.locator(".fb-panel").getByRole("button", { name: /Hide completed/ })).toHaveClass(/active/);
    await page.locator(".fb-panel").getByRole("button", { name: "Clear all", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(bar(page, done)).toBeVisible();
    await expect(row(undated.id)).toBeVisible();

    // Choosing a completed range shows done work again; hiding it clears that range.
    await toggle.click();
    await filter.getByRole("button", { name: /^Filter/ }).click();
    await page.locator(".fb-panel").getByRole("button", { name: /Completed/, exact: false }).filter({ has: page.locator(".fb-row-caret") }).click();
    await page.locator(".fb-panel").getByRole("button", { name: "This week", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(bar(page, done)).toBeVisible();
    await expect(bar(page, active)).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(bar(page, active)).toBeVisible();
    await expect(row(done.id)).toHaveCount(0);
    await toggle.click();
    await expect(bar(page, done)).toBeVisible();

    await page.setViewportSize({ width: 390, height: 900 });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(row(done.id)).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("timeline-hide-completed-phone.png") });
    await toggle.click();
    await expect(bar(page, done)).toBeVisible();
  } finally {
    for (const card of [active, done, undated]) {
      expect((await api.patch(`/api/cards/${card.id}/archive`, { data: { archived: true } })).ok()).toBe(true);
    }
  }
});

for (const lens of ["my", "team"] as const) {
  test(`${lens === "my" ? "My" : "Team"} Cards timeline Hide completed shares the query filter`, async ({ page, signIn, apiAs, uniqueName }) => {
    await signIn(page, "amelia");
    await openBoard(page, "E2E primary board");
    const api = await apiAs("amelia");
    const monday = nextPlanningMonday();
    const card = await createScheduledCard(page, api, uniqueName(`E2E ${lens} timeline completed`), monday, plusDays(monday, 2));
    const assigneeApi = lens === "my" ? api : await apiAs("priya");
    const user = (await (await assigneeApi.get("/api/me")).json()) as { id: string };
    try {
      expect((await api.put(`/api/cards/${card.id}/assignees`, { data: { userIds: [user.id] } })).ok()).toBe(true);
      expect((await api.patch(`/api/cards/${card.id}/completion`, { data: { completed: true } })).ok()).toBe(true);
      await page.goto(`/${lens}-cards`);
      await page.getByRole("button", { name: "Timeline view", exact: true }).click();
      await page.getByRole("searchbox", { name: "Search cards", exact: true }).fill(card.title);
      await expect(bar(page, card)).toBeVisible();
      const toggle = page.locator("k-board-timeline-view").getByRole("button", { name: "Hide completed", exact: true });
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect(bar(page, card)).toHaveCount(0);
      const filter = page.locator("k-filter-bar");
      await filter.getByRole("button", { name: /^Filter/ }).click();
      const menuToggle = page.locator(".fb-panel").getByRole("button", { name: /Hide completed/ });
      await expect(menuToggle).toHaveClass(/active/);
      await menuToggle.click();
      await page.keyboard.press("Escape");
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await expect(bar(page, card)).toBeVisible();
      await page.setViewportSize({ width: 390, height: 900 });
      await toggle.click();
      await expect(bar(page, card)).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath(`${lens}-timeline-hide-completed-phone.png`) });
      await toggle.click();
      await expect(bar(page, card)).toBeVisible();
    } finally {
      expect((await api.patch(`/api/cards/${card.id}/archive`, { data: { archived: true } })).ok()).toBe(true);
    }
  });
}

test("the timeline draws bars, reschedules by drag, flags conflicts and draws dependencies, live for a second member", async ({ page, signIn, pageAs, apiAs, uniqueName }) => {
  await signIn(page, "amelia");
  await openBoard(page, "E2E primary board");
  const api = await apiAs("amelia");
  const boardId = await boardIdOf(page, "E2E primary board");
  const monday = nextPlanningMonday();
  // first: Mon–Wed; second: Thu–Fri of the same week and waiting on first; third: the next Monday.
  const first = await createScheduledCard(page, api, uniqueName("E2E timeline first"), monday, plusDays(monday, 2));
  const second = await createScheduledCard(page, api, uniqueName("E2E timeline second"), plusDays(monday, 3), plusDays(monday, 4));
  const third = await createScheduledCard(page, api, uniqueName("E2E timeline third"), plusDays(monday, 7), plusDays(monday, 8));
  const created = [first, second, third];

  try {
    const link = await api.post(`/api/cards/${second.id}/relations`, { data: { targetCardId: first.id, direction: "blocked_by" } });
    expect(link.status(), await link.text()).toBe(201);
    // This scenario owns the label as well as the cards and dependency.
    const { board } = (await (await api.get(`/api/boards/${boardId}?includeCards=false`)).json()) as { board: { workspaceId: string } };
    const labelResponse = await api.post(`/api/workspaces/${board.workspaceId}/card-labels`, { data: { name: "Timeline label", color: "red" } });
    expect(labelResponse.ok(), await labelResponse.text()).toBe(true);
    const bugLabel = await labelResponse.json() as { id: string; name: string };
    expect((await api.put(`/api/cards/${first.id}/labels`, { data: { labelIds: [bugLabel.id] } })).ok()).toBe(true);

    // A second member watches the same chart; nothing below reloads their page.
    const viewer = await pageAs("marcus");
    await openBoard(viewer, "E2E primary board");
    await openTimeline(viewer);
    await expect(bar(viewer, first)).toBeVisible();
    const viewerBefore = (await bar(viewer, first).boundingBox())!;
    // The chart opens fitted to the plan, so the scale depends on the board; read it off the
    // three-day bar rather than assuming one.
    const viewerPxPerDay = viewerBefore.width / 3;
    // The only initial wire is the dependency created above.
    const wires = viewer.locator("k-board-timeline-view .tl-wire-hit");
    await expect(wireBetween(viewer, first, second)).toHaveCount(1);
    await expect(wires).toHaveCount(1);
    const baselineWires = 1;
    await expect(bar(viewer, second)).not.toHaveClass(/has-conflict/);

    await openTimeline(page);
    // The bar's name always lives in its accessible label, whether or not it fits as inline text.
    await expect(bar(page, first)).toHaveAttribute("aria-label", new RegExp(`^${first.title}\\. .*3 working days`));
    // Labels are otherwise invisible on the chart: the row shows a chip and the bar names it for screen readers.
    const firstName = page.locator(`k-board-timeline-view .tl-row-card[data-card-id="${first.id}"] .tl-card-name`);
    await expect(firstName.locator("k-card-labels .label-chip")).toContainText(bugLabel.name);
    await expect(bar(page, first)).toHaveAttribute("aria-label", new RegExp(`^${first.title}\\. ${bugLabel.name}\\. `));
    await page.screenshot({ path: test.info().outputPath("timeline-desktop.png") });

    // Drag the first bar two days later. It keeps its working-day length, so Mon–Wed becomes
    // Wed–Fri, and its dependent (Thu–Fri) now starts before it finishes: a conflict.
    const box = (await bar(page, first).boundingBox())!;
    const pxPerDay = box.width / 3;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + pxPerDay, box.y + box.height / 2, { steps: 3 });
    await page.mouse.move(box.x + box.width / 2 + pxPerDay * 2, box.y + box.height / 2, { steps: 3 });
    await page.mouse.up();
    await expect.poll(() => datesOf(api, boardId, first.id)).toEqual({ start: isoDate(plusDays(monday, 2)), due: isoDate(plusDays(monday, 4)) });
    await expect(page.locator("k-board-timeline-view .tl-count.is-warning")).toContainText(/scheduling conflict/);
    await expect(bar(page, second)).toHaveClass(/has-conflict/);

    // The other member's bar moved by the same two days, and their chart flags the conflict too.
    await expect.poll(async () => (await bar(viewer, first).boundingBox())!.x - viewerBefore.x).toBeCloseTo(viewerPxPerDay * 2, 0);
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
    await newWire.scrollIntoViewIfNeeded();
    // An elbow wire's bounding-box centre need not touch its stroke. Click the actual path.
    // Leave the bar first so its tooltip cannot cover the wire.
    await page.mouse.move(0, 0);
    const point = await newWire.evaluate((element) => {
      const path = element as SVGPathElement;
      const point = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM()!);
      return { x: point.x, y: point.y };
    });
    await page.mouse.click(point.x, point.y);
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
  await openBoard(page, "E2E primary board");
  const api = await apiAs("amelia");
  const existing = await boardIdOf(page, "E2E primary board");
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
  await openBoard(page, "E2E primary board");
  const api = await apiAs("amelia");
  const boardId = await boardIdOf(page, "E2E primary board");
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
  await openBoard(page, "E2E primary board");
  const api = await apiAs("amelia");
  const monday = nextPlanningMonday();
  const card = await createScheduledCard(page, api, uniqueName("E2E timeline zoom"), monday, plusDays(monday, 4));
  // Fit must start below the maximum zoom, and panning needs a plan wider than one short bar.
  // Give the scenario its own distant card instead of borrowing the demo's planning horizon.
  const horizon = await createScheduledCard(page, api, uniqueName("E2E timeline horizon"), plusDays(monday, 84), plusDays(monday, 88));
  try {
    await openTimeline(page);
    const scroller = page.locator("k-board-timeline-view .tl-scroller");
    // Every mounted bar sits inside the chart, between the names column and the scroller's edge.
    const allBarsInChart = async () => {
      const pane = (await page.locator("k-board-timeline-view .tl-corner").boundingBox())!;
      const view = (await scroller.boundingBox())!;
      const bars = await page.locator("k-board-timeline-view .tl-bar").evaluateAll((elements) => elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right };
      }));
      return bars.length > 0 && bars.every((box) => box.left >= pane.x + pane.width - 1 && box.right <= view.x + view.width + 1);
    };
    // With no zoom of the viewer's own, the chart opens fitted to the whole plan.
    await expect.poll(allBarsInChart, { timeout: 5000 }).toBe(true);
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

    // A zoom the viewer picked is theirs: the next visit keeps it instead of fitting again.
    const chosenWidth = (await target.boundingBox())!.width;
    await page.reload();
    await expect(target).toBeAttached();
    await expect.poll(async () => Math.round((await target.boundingBox())!.width)).toBe(Math.round(chosenWidth));

    // Grabbing the empty chart and dragging left scrolls it right by the same distance.
    await target.scrollIntoViewIfNeeded();
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
    await expect.poll(allBarsInChart, { timeout: 5000 }).toBe(true);
  } finally {
    for (const scheduled of [card, horizon]) {
      expect((await api.patch(`/api/cards/${scheduled.id}/archive`, { data: { archived: true } })).ok()).toBe(true);
    }
  }
});

test("Team Cards offers the Timeline over every board, grouped by board, live for a second member", async ({ page, signIn, pageAs, apiAs, uniqueName }) => {
  await signIn(page, "amelia");
  await openBoard(page, "E2E primary board");
  const api = await apiAs("amelia");
  const monday = nextPlanningMonday();
  const card = await createScheduledCard(page, api, uniqueName("E2E team timeline"), monday, plusDays(monday, 2));
  // Fixed boundaries keep the chart's date axis stable while the middle card moves. All three
  // share the search prefix, so filtering does not discard the anchors and refit the chart.
  const earlier = await createScheduledCard(page, api, `${card.title} earlier boundary`, plusDays(monday, -28), plusDays(monday, -24));
  const later = await createScheduledCard(page, api, `${card.title} later boundary`, plusDays(monday, 56), plusDays(monday, 60));
  const scheduled = [card, earlier, later];
  // Team Cards is the team's assigned work minus the viewer's own, so the card belongs to a third
  // teammate before either member's chart shows it.
  const priya = (await (await (await apiAs("priya")).get("/api/me")).json()) as { id?: string; user?: { id: string } };
  for (const assigned of scheduled) {
    expect((await api.put(`/api/cards/${assigned.id}/assignees`, { data: { userIds: [priya.user?.id ?? priya.id!] } })).ok()).toBe(true);
  }

  try {
    // A second member keeps the Team Cards Timeline open; the date change below reaches it live.
    const viewer = await pageAs("marcus");
    await viewer.goto("/team-cards");
    await viewer.getByRole("button", { name: "Timeline view", exact: true }).click();
    // Keep both charts scoped to the moving card and its two date boundaries.
    await viewer.getByRole("searchbox", { name: "Search cards", exact: true }).fill(card.title);
    await expect(bar(viewer, card)).toBeVisible();
    // Measure against the unchanged boundary, so initial auto-fit/scroll cannot masquerade as
    // a date change. The moving bar spans three inclusive days at the chart's current scale.
    const offsetDays = async () => {
      const moving = (await bar(viewer, card).boundingBox())!;
      const boundary = (await bar(viewer, earlier).boundingBox())!;
      return (moving.x - boundary.x) / (moving.width / 3);
    };
    await expect.poll(offsetDays).toBeCloseTo(28, 1);

    await page.goto("/team-cards");
    await page.getByRole("button", { name: "Timeline view", exact: true }).click();
    await page.getByRole("searchbox", { name: "Search cards", exact: true }).fill(card.title);
    // Across boards the chart opens grouped by board, and the card sits under its board's heading.
    const groups = page.locator("k-board-timeline-view .tl-group-name");
    await expect(groups.filter({ hasText: "E2E primary board" })).toHaveCount(1);
    await expect(bar(page, card)).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("team-cards-timeline-desktop.png") });

    // The grouping switch in the query bar regroups the same rows; "By board" exists only here.
    await page.getByRole("button", { name: "By list", exact: true }).click();
    await expect(groups.filter({ hasText: "Backlog" })).toHaveCount(1);
    await page.getByRole("button", { name: "By board", exact: true }).click();
    await expect(groups.filter({ hasText: "E2E primary board" })).toHaveCount(1);

    // Rescheduling from the API moves the other member's bar without a reload.
    const moved = await api.patch(`/api/cards/${card.id}`, { data: { startDateLocalDate: isoDate(plusDays(monday, 2)), dueDateLocalDate: isoDate(plusDays(monday, 4)) } });
    expect(moved.ok(), await moved.text()).toBe(true);
    await expect.poll(offsetDays).toBeCloseTo(30, 1);

    // A phone keeps the chart; the grouping switch folds to icons with the rest of the query bar.
    await viewer.setViewportSize({ width: 390, height: 900 });
    await expect(bar(viewer, card)).toBeVisible();
    await viewer.screenshot({ path: test.info().outputPath("team-cards-timeline-phone.png") });
  } finally {
    for (const owned of scheduled) {
      expect((await api.patch(`/api/cards/${owned.id}/archive`, { data: { archived: true } })).ok()).toBe(true);
    }
  }
});
