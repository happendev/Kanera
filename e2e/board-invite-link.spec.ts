import type { BrowserContext, Locator } from "@playwright/test";
import { contextDefaults, TEST_PASSWORD } from "./support/env";
import { expect, test } from "./support/fixtures";
import { expectBoardLoaded, openBoard, signUp, skipOnboardingInvite } from "./support/ui";

// A brand-new owner opening their board's members menu has nobody in the organisation to add. The
// menu must offer the next step instead of a dead end: an invite link that grants this board, which
// a newcomer can follow straight onto it.

const phone = { width: 390, height: 844 };

function emailFor(name: string) {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@kanera.test`;
}

async function expectInsideViewport(panel: Locator, viewport: { width: number; height: number }) {
  const box = await panel.boundingBox();
  expect(box, "members popover box").not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
}

test("a board-only owner invites someone by link from the board members menu", async ({ page, browser, runtimeGuard, uniqueName }, testInfo) => {
  const boardName = uniqueName("E2E link board");
  await signUp(page, uniqueName("E2E link owner"));
  await page.locator(".ob-kind-option").filter({ hasText: "Create a board" }).click();
  await page.getByPlaceholder("e.g. Product launch").fill(boardName);
  await page.locator(".ob-footer").getByRole("button", { name: "Create board" }).click();
  await skipOnboardingInvite(page);
  await expect(page).toHaveURL(/\/b\/[^/]+$/);
  await expectBoardLoaded(page, boardName);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: contextDefaults.baseURL });

  const menu = page.locator("k-board-members-menu");
  const invite = menu.locator(".bmp-invite");

  // Phone first: the popover stays anchored and on screen, and the action is reachable.
  await page.setViewportSize(phone);
  await page.locator(".board-members-trigger").filter({ visible: true }).click();
  await expect(invite).toContainText("All organisation members are already on this board.");
  await expect(invite.getByRole("button", { name: "Invite by link" })).toBeVisible();
  await expectInsideViewport(menu.locator(".bmp-panel"), phone);
  await menu.screenshot({ path: testInfo.outputPath("members-invite-phone.png") });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  await page.setViewportSize(contextDefaults.viewport);
  await page.locator(".board-members-trigger").click();
  // The dead-end note now sits with the invite action, which defaults to Editor.
  await expect(invite).toContainText("All organisation members are already on this board.");
  await expect(invite.getByRole("combobox", { name: "Role for people who join with the link" })).toHaveValue("editor");
  await invite.getByRole("button", { name: "Invite by link" }).click();

  const linkField = invite.getByRole("textbox", { name: "Invite link" });
  await expect(linkField).toHaveValue(/\/signup\?invite=/);
  const inviteUrl = await linkField.inputValue();
  await expect(invite).toContainText("Anyone with this link can join this board as an editor. It expires on");
  await expect(invite.getByRole("button", { name: "Copy invite link" })).toContainText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(inviteUrl);
  await menu.screenshot({ path: testInfo.outputPath("members-invite-link-desktop.png") });

  // The long link truncates inside the panel instead of widening it, and stays copyable at phone width.
  await page.setViewportSize(phone);
  await expect(linkField).toBeVisible();
  await expectInsideViewport(menu.locator(".bmp-panel"), phone);
  const fieldBox = await linkField.boundingBox();
  const panelBox = await menu.locator(".bmp-panel").boundingBox();
  expect(fieldBox!.x + fieldBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width);
  await menu.screenshot({ path: testInfo.outputPath("members-invite-link-phone.png") });
  await page.setViewportSize(contextDefaults.viewport);

  const contexts: BrowserContext[] = [];
  try {
    const newcomerContext = await browser.newContext(contextDefaults);
    contexts.push(newcomerContext);
    runtimeGuard.watchContext(newcomerContext, "newcomer");
    const newcomer = await newcomerContext.newPage();
    const newcomerName = uniqueName("E2E link newcomer");
    await newcomer.goto(new URL(inviteUrl).pathname + new URL(inviteUrl).search);
    await expect(newcomer.locator(".invite-banner")).toContainText("You've been invited to join");
    await newcomer.locator("#dn").fill(newcomerName);
    await newcomer.locator("#email").fill(emailFor(newcomerName));
    await newcomer.locator("#password").fill(TEST_PASSWORD);
    await newcomer.locator("form").getByRole("button", { name: "Continue" }).click();

    await expect(newcomer.locator("k-app-shell")).toBeVisible();
    await expect(newcomer).not.toHaveURL(/\/onboarding/);
    await openBoard(newcomer, boardName);
    await newcomer.screenshot({ path: testInfo.outputPath("newcomer-board.png") });

    // The owner's open menu picks the newcomer up live, as an editor.
    await expect(menu).toContainText(newcomerName);
    await menu.screenshot({ path: testInfo.outputPath("owner-roster-desktop.png") });
  } finally {
    for (const context of contexts) await context.close();
  }
});
