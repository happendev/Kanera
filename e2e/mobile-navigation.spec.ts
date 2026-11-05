import type { CDPSession } from "@playwright/test";
import { test, expect } from "./support/scenario";
import { expectBoardLoaded } from "./support/ui";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/** A real touch stream (touchstart → touchmove… → touchend), which page.touchscreen cannot make. */
async function swipe(cdp: CDPSession, from: { x: number; y: number }, to: { x: number; y: number }) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  // A finger reports a few pixels per move, so the first touchmove is short, as on a device.
  const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 4);
  for (let step = 1; step <= steps; step += 1) {
    const point = { x: from.x + ((to.x - from.x) * step) / steps, y: from.y + ((to.y - from.y) * step) / steps };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("unread notifications are one tap or one edge swipe away on a phone", async ({ page, signIn, apiAs, testWorkspace, uniqueName }, testInfo) => {
  await signIn(page, "amelia", `/b/${testWorkspace.boardId}`);
  await expectBoardLoaded(page, testWorkspace.boardName);
  const header = page.locator("k-page-header").first();
  const bell = header.locator(".ph-bell");
  const panel = page.getByRole("dialog", { name: "Notifications", exact: true });
  await expect(bell).toHaveCount(0);
  await expect(header.locator(".ph-icon")).toBeVisible();

  // Arrives over realtime while the board is open: Marcus assigns Amelia a card.
  const amelia = await (await (await apiAs("amelia")).get("/api/me")).json() as { id: string };
  const created = await (await apiAs("marcus")).post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")}/cards`, {
    data: { title: uniqueName("E2E phone bell card"), assigneeIds: [amelia.id] },
  });
  expect(created.ok(), await created.text()).toBe(true);
  await expect(bell).toBeVisible();
  await expect(bell).toHaveAccessibleName("Notifications (1 unread)");
  await expect(bell.locator(".ph-bell-count")).toHaveText("1");
  // The bell takes the lead icon's place rather than adding to the crowded title row.
  await expect(header.locator(".ph-icon")).toHaveCount(0);
  await expect(header.getByRole("heading", { level: 1, name: testWorkspace.boardName })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("phone-board-header-bell.png") });

  await bell.click();
  await expect(panel).toBeVisible();
  await expect(page.locator("aside.sidebar")).toHaveClass(/collapsed/);
  await page.screenshot({ path: testInfo.outputPath("phone-notifications-from-bell.png") });
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  const cdp = await page.context().newCDPSession(page);
  const lists = page.locator("k-board").first();
  const scrollLeft = () => lists.evaluate((element) => element.scrollLeft);
  // A leftward swipe from inside the page is the board's own scroll, not the panel's gesture.
  await swipe(cdp, { x: 300, y: 500 }, { x: 150, y: 500 });
  await page.waitForTimeout(300);
  await expect(panel).toBeHidden();
  await expect.poll(scrollLeft).toBeGreaterThan(0);
  // Let the snap settle before resetting, or it carries on past the reset.
  let settled = -1;
  await expect.poll(async () => {
    const previous = settled;
    settled = await scrollLeft();
    return settled === previous;
  }).toBe(true);
  await lists.evaluate((element) => element.scrollTo({ left: 0, behavior: "instant" }));
  await expect.poll(scrollLeft).toBe(0);
  // A vertical drag that starts on the edge stays a scroll.
  await swipe(cdp, { x: 386, y: 400 }, { x: 384, y: 600 });
  await page.waitForTimeout(300);
  await expect(panel).toBeHidden();

  await swipe(cdp, { x: 386, y: 500 }, { x: 250, y: 505 });
  await expect(panel).toBeVisible();
  // The swipe claimed its touch, so the board did not scroll under the panel it opened.
  expect(await scrollLeft()).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("phone-notifications-from-swipe.png") });
  // The edge belongs to the panel while it is open: another swipe does not toggle it shut.
  await swipe(cdp, { x: 386, y: 500 }, { x: 250, y: 505 });
  await page.waitForTimeout(300);
  await expect(panel).toBeVisible();
});

test("mobile navigation opens, dismisses and remains usable with reduced motion", async ({ page, signIn }, testInfo) => {
  await signIn(page, "amelia");
  const sidebar = page.locator("aside.sidebar");
  await expect(sidebar).toHaveClass(/collapsed/);
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await expect.poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().x)).toBe(0);
  await expect(sidebar.getByRole("button", { name: /^Up next/ })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /^Notifications/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mobile-menu-open.png") });
  await page.locator(".sidebar-backdrop").click({ position: { x: 350, y: 300 } });
  await expect(sidebar).toBeHidden();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await expect(sidebar).toBeVisible();
  await sidebar.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expect(sidebar).toBeHidden();
  await expect(page.getByRole("button", { name: /^Up next/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Notifications/ })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("mobile-menu-closed.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(sidebar).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("desktop-navigation.png") });
});
