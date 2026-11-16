import type { BrowserContext } from "@playwright/test";
import { contextDefaults, TEST_PASSWORD } from "./support/env";
import { expect, test } from "./support/fixtures";
import { expectBoardLoaded, openBoard, signUp, skipOnboardingInvite } from "./support/ui";

// An account that started with "Create a board" has a standalone board and no workspace. Its owner
// must still be able to invite someone, and the invite must carry board access: workspace
// membership alone opens no board, so an invite without it lands the person on an empty Home.

function emailFor(name: string) {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@kanera.test`;
}

test("a standalone-board owner invites someone onto that board and the newcomer lands with it", async ({ page, browser, runtimeGuard, uniqueName }, testInfo) => {
  const boardName = uniqueName("E2E invited board");
  await signUp(page, uniqueName("E2E board owner"));
  await page.locator(".ob-kind-option").filter({ hasText: "Create a board" }).click();
  await page.getByPlaceholder("e.g. Product launch").fill(boardName);
  await page.locator(".ob-footer").getByRole("button", { name: "Create board" }).click();
  await skipOnboardingInvite(page);
  await expect(page).toHaveURL(/\/b\/[^/]+$/);
  await expectBoardLoaded(page, boardName);

  await page.goto("/settings/users");
  const form = page.locator("form.invite-form");
  // No workspace to pick, and the only board is the default.
  await expect(form.getByText("Workspace access")).toHaveCount(0);
  await expect(form.getByText("Board access")).toBeVisible();
  const boardRow = form.locator(".ws-grant-row").filter({ hasText: boardName });
  await expect(boardRow.getByRole("checkbox")).toBeChecked();
  await expect(boardRow.getByRole("combobox")).toHaveValue("editor");
  await form.screenshot({ path: testInfo.outputPath("invite-form-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await form.screenshot({ path: testInfo.outputPath("invite-form-phone.png") });
  await page.setViewportSize(contextDefaults.viewport);

  await form.getByRole("button", { name: "Create invite" }).click();
  const inviteUrl = (await page.locator(".invite-url-text").innerText()).trim();
  expect(inviteUrl).toContain("/signup?invite=");
  await expect(page.locator(".invite-row").filter({ hasText: boardName })).toBeVisible();

  // Watch the owner's open roster: the grant fans out as an ordinary board member add.
  await openBoard(page, boardName);
  await page.locator(".board-members-trigger").click();

  const contexts: BrowserContext[] = [];
  try {
    const newcomerContext = await browser.newContext(contextDefaults);
    contexts.push(newcomerContext);
    runtimeGuard.watchContext(newcomerContext, "newcomer");
    const newcomer = await newcomerContext.newPage();
    const newcomerName = uniqueName("E2E invited newcomer");
    await newcomer.goto(new URL(inviteUrl).pathname + new URL(inviteUrl).search);
    await expect(newcomer.locator(".invite-banner")).toContainText("You've been invited to join");
    await newcomer.locator("#dn").fill(newcomerName);
    await newcomer.locator("#email").fill(emailFor(newcomerName));
    await newcomer.locator("#password").fill(TEST_PASSWORD);
    await newcomer.locator("form").getByRole("button", { name: "Continue" }).click();

    // A member lands on Home, never onboarding, and the granted board is in their navigation.
    await expect(newcomer.locator("k-app-shell")).toBeVisible();
    await expect(newcomer).not.toHaveURL(/\/onboarding/);
    await openBoard(newcomer, boardName);
    await newcomer.screenshot({ path: testInfo.outputPath("newcomer-board.png") });

    await expect(page.locator("k-board-members-menu")).toContainText(newcomerName);
    await page.screenshot({ path: testInfo.outputPath("owner-roster.png") });
  } finally {
    for (const context of contexts) await context.close();
  }
});
