import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { boardIdOf, openBoard } from "./support/ui";
import { contextDefaults } from "./support/env";

// The Dependencies view. The blocker lives on Mobile Experience and the chain is viewed from
// Platform Delivery, so the map can only learn about it by walking across boards, and a second
// member's open map can only change through realtime from boards it joined for the walk.

type CreatedCard = { id: string; key: string; title: string; workspaceId: string };

async function createCardOnBoard(page: Page, api: APIRequestContext, boardName: string, title: string): Promise<CreatedCard> {
  const boardId = await boardIdOf(page, boardName);
  const board = await api.get(`/api/boards/${boardId}?includeCards=false`);
  const { lists } = (await board.json()) as { lists: { id: string; name: string }[] };
  const backlog = lists.find((list) => list.name === "Backlog") ?? lists[0]!;
  const created = await api.post(`/api/boards/${boardId}/lists/${backlog.id}/cards`, { data: { title, atTop: true } });
  expect(created.ok(), await created.text()).toBe(true);
  return (await created.json()) as CreatedCard;
}

async function block(api: APIRequestContext, blocker: CreatedCard, blocked: CreatedCard) {
  const response = await api.post(`/api/cards/${blocked.id}/relations`, { data: { targetCardId: blocker.id, direction: "blocked_by" } });
  expect(response.status(), await response.text()).toBe(201);
}

function mapTile(page: Page, title: string) {
  return page.locator("k-dependency-map .dm-tile").filter({ hasText: title });
}

test("the dependencies view maps a cross-board chain, updates live and opens cards", async ({ page, signIn, pageAs, apiAs, uniqueName }) => {
  await signIn(page, "amelia");
  await openBoard(page, "Platform Delivery");
  const api = await apiAs("amelia");
  const blocker = await createCardOnBoard(page, api, "Mobile Experience", uniqueName("E2E map upstream"));
  const blocked = await createCardOnBoard(page, api, "Platform Delivery", uniqueName("E2E map launch"));
  const created: CreatedCard[] = [blocker, blocked];

  try {
    await block(api, blocker, blocked);

    const viewer = await pageAs("marcus");
    await openBoard(viewer, "Platform Delivery");
    await viewer.getByRole("button", { name: "Dependencies view", exact: true }).click();
    await expect(viewer).toHaveURL(/view=dependencies/);

    // The board's card, and the blocker pulled in from the other board as dashed context.
    await expect(mapTile(viewer, blocked.title)).toHaveClass(/is-blocked/);
    await expect(mapTile(viewer, blocker.title)).toHaveClass(/is-context/);
    await expect(mapTile(viewer, blocker.title)).toContainText("Mobile Experience");
    await expect(mapTile(viewer, blocked.title)).toHaveAttribute("aria-label", new RegExp(`Waiting on ${blocker.key}`));

    // Tiles carry labels like board cards do, and a label set elsewhere shows up without a reload.
    const workspace = await api.get(`/api/workspaces/${blocked.workspaceId}`);
    const label = ((await workspace.json()) as { cardLabels: { id: string; name: string }[] }).cardLabels[0]!;
    expect((await api.put(`/api/cards/${blocked.id}/labels`, { data: { labelIds: [label.id] } })).ok()).toBe(true);
    await expect(mapTile(viewer, blocked.title).locator(".dm-labels")).toContainText(label.name);

    // Slim cards drop to key and title; pressing again brings the detail back.
    const slim = viewer.locator("k-dependency-map").getByRole("button", { name: "Slim cards" });
    await slim.click();
    await expect(slim).toHaveAttribute("aria-pressed", "true");
    await expect(mapTile(viewer, blocked.title)).toHaveClass(/is-slim/);
    await expect(mapTile(viewer, blocked.title).locator(".dm-labels")).toHaveCount(0);
    await slim.click();
    await expect(mapTile(viewer, blocked.title).locator(".dm-labels")).toContainText(label.name);

    // A new dependent added elsewhere joins the chain on the open map without a reload.
    const followUp = await createCardOnBoard(page, api, "Platform Delivery", uniqueName("E2E map follow-up"));
    created.push(followUp);
    await block(api, blocked, followUp);
    await expect(mapTile(viewer, followUp.title)).toBeVisible();
    const chain = viewer.locator("k-dependency-map .dm-chain").filter({ hasText: followUp.title });
    await expect(chain.locator(".dm-step-label")).toHaveText(["Step 1", "Step 2", "Step 3"]);

    // Completing the blocker on the other board hands the card off: it reads Ready, live.
    expect((await api.patch(`/api/cards/${blocker.id}/completion`, { data: { completed: true } })).ok()).toBe(true);
    await expect(mapTile(viewer, blocked.title)).toHaveClass(/is-ready/);
    await expect(mapTile(viewer, blocker.title)).toHaveClass(/is-done/);

    // The Ready count filters to chains holding a ready card; pressing it again shows everything.
    const ready = viewer.locator("k-dependency-map .dm-stat.is-ready");
    await ready.click();
    await expect(ready).toHaveAttribute("aria-pressed", "true");
    await expect(mapTile(viewer, blocked.title)).toHaveClass(/is-match/);
    await viewer.screenshot({ path: test.info().outputPath("dependency-map-desktop.png") });
    await ready.click();

    // The steps layout on a phone carries the same chain as a list.
    await viewer.setViewportSize({ width: 390, height: 900 });
    await viewer.getByRole("group", { name: "Dependencies layout", exact: true }).getByRole("button", { name: "Steps", exact: true }).click();
    const row = viewer.locator("k-dependency-map .dm-row").filter({ hasText: followUp.title });
    await expect(row).toContainText(`Waiting on ${blocked.key}`);
    await viewer.screenshot({ path: test.info().outputPath("dependency-map-phone.png") });
    await viewer.getByRole("group", { name: "Dependencies layout", exact: true }).getByRole("button", { name: "Map", exact: true }).click();
    await viewer.setViewportSize({ width: 1280, height: 900 });

    // A tile opens the card in the board's drawer.
    await mapTile(viewer, followUp.title).click();
    await expect(viewer.locator("k-card-detail")).toContainText(followUp.title);
  } finally {
    for (const card of created) {
      expect((await api.patch(`/api/cards/${card.id}/archive`, { data: { archived: true } })).ok()).toBe(true);
    }
  }
});

test("the dependencies map adds and removes dependencies in place, with critical path and timeline", async ({ page, signIn, pageAs, apiAs, uniqueName }) => {
  await signIn(page, "amelia");
  await openBoard(page, "Platform Delivery");
  const api = await apiAs("amelia");
  // Two separate chains: first → middle, and other → last. Dragging first onto last joins them.
  const first = await createCardOnBoard(page, api, "Platform Delivery", uniqueName("E2E edit first"));
  const middle = await createCardOnBoard(page, api, "Platform Delivery", uniqueName("E2E edit middle"));
  const other = await createCardOnBoard(page, api, "Platform Delivery", uniqueName("E2E edit other"));
  const last = await createCardOnBoard(page, api, "Platform Delivery", uniqueName("E2E edit last"));
  const created = [first, middle, other, last];

  try {
    await block(api, first, middle);
    await block(api, other, last);

    // A second member keeps the map open; every change below reaches it through realtime alone.
    const viewer = await pageAs("marcus");
    await openBoard(viewer, "Platform Delivery");
    await viewer.getByRole("button", { name: "Dependencies view", exact: true }).click();
    await expect(mapTile(viewer, last.title)).toBeVisible();

    await page.getByRole("button", { name: "Dependencies view", exact: true }).click();
    const map = page.locator("k-dependency-map");
    await expect(mapTile(page, last.title)).toBeVisible();

    // Drag from the first card's handle and drop on the last card: first now blocks last.
    await mapTile(page, first.title).hover();
    const handle = map.locator(`.dm-link-handle[aria-label="Add a card that ${first.key} blocks"]`);
    const from = (await handle.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 60, from.y + 30, { steps: 4 });
    await expect(mapTile(page, middle.title)).toHaveClass(/is-link-muted/);
    const target = (await mapTile(page, last.title).boundingBox())!;
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
    await expect(mapTile(page, last.title)).toHaveClass(/is-link-over/);
    await page.mouse.up();
    const connector = map.locator(`.dm-wire-hit[aria-label="${first.key} blocks ${last.key}"]`);
    await expect(connector).toHaveCount(1);
    await expect(mapTile(viewer, last.title)).toHaveAttribute("aria-label", new RegExp(`Waiting on (${other.key}, ${first.key}|${first.key}, ${other.key})`));

    // Ctrl/⌘+Z takes the new dependency back and Ctrl/⌘+Shift+Z puts it back, live for the other viewer.
    await expect(page.getByRole("status").filter({ hasText: `${last.key} now waits on ${first.key}` })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(connector).toHaveCount(0);
    await expect(mapTile(viewer, last.title)).not.toHaveAttribute("aria-label", new RegExp(first.key));
    await expect(page.getByRole("status").filter({ hasText: `${last.key} no longer waits on ${first.key}` })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(connector).toHaveCount(1);
    await expect(mapTile(viewer, last.title)).toHaveAttribute("aria-label", new RegExp(first.key));

    // The critical path lights every longest open run: here first → middle, first → last and
    // other → last tie at two cards, so all four cards are on it.
    await map.getByRole("button", { name: "Critical path" }).click();
    const chain = map.locator(".dm-chain").filter({ hasText: last.title });
    await expect(chain.locator(".dm-pill.is-critical")).toHaveText("4 cards on the critical path");
    await expect(mapTile(page, last.title)).toHaveClass(/is-critical/);
    await map.getByRole("button", { name: "Critical path" }).click();

    // Removing it from its connector reaches the other viewer, and Undo puts it back.
    await connector.focus();
    await page.keyboard.press("Enter");
    await map.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(connector).toHaveCount(0);
    await expect(mapTile(viewer, last.title)).not.toHaveAttribute("aria-label", new RegExp(first.key));
    const toast = page.getByRole("status").filter({ hasText: `${last.key} no longer waits on ${first.key}` });
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(connector).toHaveCount(1);
    await expect(mapTile(viewer, last.title)).toHaveAttribute("aria-label", new RegExp(first.key));

    // On the timeline cards sit by due week: a blocker due after the card it blocks lands to its
    // right, and an undated card stays in the first column.
    expect((await api.patch(`/api/cards/${first.id}`, { data: { dueDateLocalDate: "2099-06-19", dueDateSlot: "anyTime" } })).ok()).toBe(true);
    expect((await api.patch(`/api/cards/${last.id}`, { data: { dueDateLocalDate: "2099-06-02", dueDateSlot: "anyTime" } })).ok()).toBe(true);
    await page.getByRole("group", { name: "Dependencies layout", exact: true }).getByRole("button", { name: "Timeline", exact: true }).click();
    await expect(chain.locator(".dm-step-label").first()).toHaveText("No due date");
    // One calendar for every chain: each lane has the same week headings in the same places, and
    // the years of empty weeks before 2099 collapse behind a dashed marker.
    const headings = await map.locator(".dm-chain").evaluateAll((chains) =>
      chains.map((lane) => Array.from(lane.querySelectorAll<HTMLElement>(".dm-step-label")).map((label) => `${label.textContent?.trim()}@${label.style.left}`).join("|")));
    expect(headings.length).toBeGreaterThan(1);
    expect(new Set(headings).size).toBe(1);
    await expect(chain.locator(".dm-week-gap").first()).toBeAttached();
    await expect(mapTile(page, last.title)).toHaveClass(/is-risk/);
    const blockerBox = (await mapTile(page, first.title).boundingBox())!;
    const dependentBox = (await mapTile(page, last.title).boundingBox())!;
    expect(blockerBox.x).toBeGreaterThan(dependentBox.x);
    await page.screenshot({ path: test.info().outputPath("dependency-map-timeline.png") });
    await page.getByRole("group", { name: "Dependencies layout", exact: true }).getByRole("button", { name: "Map", exact: true }).click();
  } finally {
    for (const card of created) {
      expect((await api.patch(`/api/cards/${card.id}/archive`, { data: { archived: true } })).ok()).toBe(true);
    }
  }
});

// These are rendered-layout regressions: CSS breakpoints, packed heights and pointer media queries
// need a real browser. A DOM-only component test cannot catch the squeezed title or clipped header.
test("dependency layouts keep titles, badges and touch controls usable across screen sizes", async ({ browser, signIn, apiAs, uniqueName, runtimeGuard }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ ...contextDefaults, hasTouch: true });
  runtimeGuard.watchContext(context, "responsive dependencies");
  const page = await context.newPage();
  const api = await apiAs("priya");
  const created: CreatedCard[] = [];
  try {
    await signIn(page, "priya");
    await openBoard(page, "Platform Delivery");
    const boardUrl = page.url();
    const first = await createCardOnBoard(page, api, "Platform Delivery", uniqueName("Responsive dependency blocker"));
    created.push(first);
    const last = await createCardOnBoard(page, api, "Platform Delivery", uniqueName("Responsive dependency goal"));
    created.push(last);
    const me = await (await api.get("/api/me")).json() as { id?: string; user?: { id: string } };
    const teammateApi = await apiAs("marcus");
    const teammate = await (await teammateApi.get("/api/me")).json() as { id?: string; user?: { id: string } };
    // Team Cards excludes the viewer's own assignments, so both lenses need an assignee in scope.
    for (const card of created) {
      expect((await api.put(`/api/cards/${card.id}/assignees`, { data: { userIds: [me.user?.id ?? me.id!, teammate.user?.id ?? teammate.id!] } })).ok()).toBe(true);
    }
    // The blocker is due after its goal, so the header has critical, risk and blocked badges at once.
    expect((await api.patch(`/api/cards/${first.id}`, { data: { dueDateLocalDate: "2020-06-19", dueDateSlot: "anyTime" } })).ok()).toBe(true);
    expect((await api.patch(`/api/cards/${last.id}`, { data: { dueDateLocalDate: "2020-06-02", dueDateSlot: "anyTime" } })).ok()).toBe(true);
    await block(api, first, last);

    for (const [surface, url] of [["board", boardUrl], ["my-cards", "/my-cards"], ["team-cards", "/team-cards"]]) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(url!);
      await page.getByRole("button", { name: "Dependencies view", exact: true }).click();
      const map = page.locator("k-dependency-map");
      const chain = map.locator(".dm-chain").filter({ hasText: last.title });
      await expect(chain).toBeVisible();
      const critical = map.getByRole("button", { name: "Critical path", exact: true });
      if (await critical.getAttribute("aria-pressed") !== "true") await critical.tap();
      await expect(chain.locator(".dm-pill.is-risk")).toBeVisible();
      await expect(chain.locator(".dm-pill.is-blocked")).toBeVisible();
      await expect(chain.locator(".dm-pill.is-critical")).toBeVisible();

      for (const width of [1024, 1440, 768, 640, 390, 320]) {
        await page.setViewportSize({ width, height: width < 700 ? 844 : 900 });
        for (const layout of ["Steps", "Map", "Timeline"]) {
          await page.getByRole("group", { name: "Dependencies layout", exact: true }).getByRole("button", { name: layout, exact: true }).tap();
          const layoutClass = { Steps: "list", Map: "map", Timeline: "timeline" }[layout];
          await expect(map.locator(".dm-chains")).toHaveClass(new RegExp(`is-${layoutClass}`));
          if (layout === "Steps") {
            const title = chain.locator(".dm-row-main").first();
            await expect.poll(async () => (await title.boundingBox())!.width, { message: `${surface} ${width}px: readable Steps title` }).toBeGreaterThanOrEqual(width >= 768 ? 200 : 100);
          } else {
            await expect.poll(async () => (await chain.locator(".dm-chain-goal").boundingBox())!.width, { message: `${surface} ${width}px: visible chain title` }).toBeGreaterThanOrEqual(100);
            const header = chain.locator(".dm-chain-head");
            expect(await header.evaluate((el) => el.scrollWidth - el.clientWidth), `${surface} ${width}px: badges fit header`).toBeLessThanOrEqual(1);
            const boxes = await chain.locator(".dm-chain-head, .dm-canvas").evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
            expect(boxes[1]!.top).toBeGreaterThanOrEqual(boxes[0]!.bottom - 1);
            const chainBox = (await chain.boundingBox())!;
            expect(boxes[1]!.bottom, "packing reserves the full header and canvas height").toBeLessThanOrEqual(chainBox.y + chainBox.height + 1);
          }
          const targets = await map.locator(".dm-controls button").evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { name: el.getAttribute("aria-label") ?? el.textContent, width: r.width, height: r.height }; }));
          for (const target of targets) {
            expect(target.width, `${target.name} touch width`).toBeGreaterThanOrEqual(44);
            expect(target.height, `${target.name} touch height`).toBeGreaterThanOrEqual(44);
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth), `${surface} ${width}px: page stays within viewport`).toBeLessThanOrEqual(width);
          if (width === 390 || width === 1024 && layout === "Steps" || width === 320 && layout !== "Steps") {
            await page.screenshot({ path: test.info().outputPath(`${surface}-${width}-${layout.toLowerCase()}.png`) });
          }
        }
      }
    }
  } finally {
    for (const card of created) {
      expect((await api.patch(`/api/cards/${card.id}/archive`, { data: { archived: true } })).ok()).toBe(true);
    }
    await context.close();
  }
});
