import type { Browser, BrowserContext, Page } from "@playwright/test";
import { contextDefaults, TEST_PASSWORD, webOrigin } from "./support/env";
import { expect, test } from "./support/fixtures";
import { cardTile, expectBoardLoaded, openBoard, scrollBoardToEnd, signUp } from "./support/ui";

// The Development Team template's example cards, seeded onto every board created from it.
const DEVELOPMENT_EXAMPLE_CARDS = [
  "Plan the next release",
  "Set up the project repository",
  "Fix the login error on Safari",
  "Add CSV export to reports",
];

async function expectExampleCards(page: Page) {
  for (const title of DEVELOPMENT_EXAMPLE_CARDS) await expect(cardTile(page, title)).toHaveCount(1);
}

/** Creates the closing step's invite link and returns it. */
async function createOnboardingInviteLink(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Create invite link" }).click();
  const inviteUrl = await page.locator(".ob-invite-url").inputValue();
  expect(inviteUrl).toContain("/signup?invite=");
  return inviteUrl;
}

async function openInviteAsNewcomer(
  browser: Browser,
  runtimeGuard: { watchContext(context: BrowserContext, label: string): void },
  inviteUrl: string,
) {
  const context = await browser.newContext(contextDefaults);
  runtimeGuard.watchContext(context, "newcomer");
  const newcomer = await context.newPage();
  const url = new URL(inviteUrl);
  await newcomer.goto(url.pathname + url.search);
  return { context, newcomer };
}

test("signup creates a workspace whose lists and fields belong to a second board", async ({ page, browser, runtimeGuard, uniqueName }, testInfo) => {
  const workspaceName = uniqueName("E2E Workspace");
  const listName = uniqueName("E2E List");
  const fieldName = uniqueName("E2E Field");
  const secondBoard = uniqueName("E2E Second Board");

  await signUp(page, uniqueName("E2E workspace signup"));
  await page.locator(".ob-kind-option").filter({ hasText: "Create a workspace" }).click();
  await page.getByRole("button", { name: "Set up workspace" }).last().click();
  await page.locator(".ob-template-option").filter({ hasText: "Development Team" }).click();
  // The template grid is several screens tall on a phone; Continue stays pinned in view.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".ob-footer").getByRole("button", { name: "Continue" })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("workspace-template-step-phone.png"), animations: "disabled" });
  await page.setViewportSize(contextDefaults.viewport);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator('input[name="name"]').fill(workspaceName);
  await page.getByRole("button", { name: "Continue" }).click();
  const workflowColors = [
    ["Wishlist", "purple"],
    ["Planning / Review", "violet"],
    ["Backlog", "gray"],
    ["Bugs / Issues / Feedback", "red"],
    ["Awaiting Feedback", "amber"],
    ["In Progress", "blue"],
    ["Ready for QA", "teal"],
    ["Complete", "green"],
  ];
  for (const [name, color] of workflowColors) {
    await expect(page.locator(".ob-item").filter({ has: page.locator("span", { hasText: name }) }).locator(".ob-icon"))
      .toHaveAttribute("style", `color: var(--color-${color});`);
  }
  await page.screenshot({ path: test.info().outputPath("template-list-colors-desktop.png"), fullPage: true });
  const desktopViewport = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath("template-list-colors-phone.png"), fullPage: true });
  await page.setViewportSize(desktopViewport);
  await page.getByPlaceholder("New list name").fill(listName);
  await page.getByRole("button", { name: "Add list" }).click();
  // The Development Team template marks "In Progress" as active work; a custom list can opt in too.
  await expect(page.getByRole("button", { name: "Unmark In Progress as in progress", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Mark Backlog as in progress", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: `Mark ${listName} as in progress`, exact: true }).click();
  await expect(page.getByRole("button", { name: `Unmark ${listName} as in progress`, exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("Field name").fill(fieldName);
  await page.getByRole("button", { name: "Add field" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Finish setup" }).click();
  // Setup closes on the invite step. Its link grants the new workspace and its board.
  await expect(page.getByRole("heading", { name: "Who works on this with you?" })).toBeVisible();
  const inviteUrl = await createOnboardingInviteLink(page);
  await page.screenshot({ path: testInfo.outputPath("workspace-invite-step-desktop.png"), fullPage: true });
  await page.locator(".ob-footer").getByRole("button", { name: "Go to board" }).click();
  await expectBoardLoaded(page, "Engineering");
  await expectExampleCards(page);
  await expect(page.locator("k-app-shell")).toBeVisible();
  await expect(page).not.toHaveURL(/\/onboarding/);

  const firstBoard = page.locator("a.board-link").filter({ hasText: "Engineering" }).first();
  await expect(firstBoard).toBeVisible();
  await firstBoard.click();
  await expectBoardLoaded(page, "Engineering");
  for (const [name, color] of workflowColors) {
    await expect(page.locator("k-list .list-header h3").filter({ hasText: name }))
      .toHaveAttribute("style", `--list-color: var(--color-${color});`);
  }
  await scrollBoardToEnd(page);
  await expect(page.locator("k-list").filter({ hasText: listName })).toHaveCount(1);
  // Both flags reached the created workspace: the list headers wear the in-progress marker.
  await expect(page.locator("k-list").filter({ hasText: listName }).locator(".list-in-progress")).toHaveCount(1);
  await expect(page.locator("k-list").filter({ has: page.locator(".list-header h3", { hasText: /^\s*\d*\s*In Progress/ }) }).locator(".list-in-progress")).toHaveCount(1);
  await expect(page.locator("k-list").filter({ has: page.locator(".list-header h3", { hasText: "Backlog" }) }).locator(".list-in-progress")).toHaveCount(0);
  const settingsHref = await page.locator("a.ws-settings").filter({ visible: true }).first().getAttribute("href");
  expect(settingsHref).toMatch(/^\/w\/[^/]+\/settings$/);
  await page.goto(`${settingsHref}/boards`);
  await page.getByPlaceholder("Board name").fill(secondBoard);
  await page.getByRole("button", { name: "Add board" }).click();
  const secondLink = page.locator("a.board-link").filter({ hasText: secondBoard }).first();
  await expect(secondLink).toBeVisible();
  await secondLink.click();
  await expectBoardLoaded(page, secondBoard);
  await expect(page.locator("k-list .list-header h3").filter({ hasText: "In Progress" }))
    .toHaveAttribute("style", "--list-color: var(--color-blue);");
  await scrollBoardToEnd(page);
  // Lists and custom fields are workspace-scoped: a board created later inherits both.
  await expect(page.locator("k-list").filter({ hasText: listName })).toHaveCount(1);
  await page.getByRole("button", { name: "Table view" }).click();
  await expect(page.locator("k-board-table-view")).toContainText(fieldName);
  await page.reload();
  await expect(page.locator("k-board-table-view")).toContainText(fieldName);
  await page.goto("/");
  await expect(page).toHaveURL(`${webOrigin}/`);
  await expect(page.locator("k-app-shell")).toBeVisible();

  // Workspace membership alone opens no board, so someone joining through the onboarding link must
  // also be able to open the workspace's board.
  const { context, newcomer } = await openInviteAsNewcomer(browser, runtimeGuard, inviteUrl);
  try {
    const newcomerName = uniqueName("E2E onboarding invitee");
    await newcomer.locator("#dn").fill(newcomerName);
    await newcomer.locator("#email").fill(`${newcomerName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@kanera.test`);
    await newcomer.locator("#password").fill(TEST_PASSWORD);
    await newcomer.locator("form").getByRole("button", { name: "Continue" }).click();
    await expect(newcomer.locator("k-app-shell")).toBeVisible();
    await expect(newcomer).not.toHaveURL(/\/onboarding/);
    await openBoard(newcomer, "Engineering");
    await expectBoardLoaded(newcomer, "Engineering");
    await expectExampleCards(newcomer);
  } finally {
    await context.close();
  }
});

test("signup can start with a standalone board without completing workspace onboarding", async ({ page, browser, runtimeGuard, uniqueName }, testInfo) => {
  const boardName = uniqueName("E2E Solo");
  const orgName = uniqueName("E2E Studio");
  await signUp(page, uniqueName("E2E standalone signup"));
  await page.locator(".ob-kind-option").filter({ hasText: "Create a board" }).click();
  await page.getByPlaceholder("e.g. Product launch").fill(boardName);
  const desktopViewport = page.viewportSize()!;
  const createBoard = page.locator(".ob-footer").getByRole("button", { name: "Create board" });
  // On a phone the twelve templates fill several screens; the footer stays pinned in view.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(createBoard).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("board-step-phone.png"), animations: "disabled" });
  await page.setViewportSize(desktopViewport);
  await page.screenshot({ path: testInfo.outputPath("board-step-desktop.png") });
  await createBoard.click();

  // The closing step: the organisation is still named by signup's placeholder until the owner renames it.
  await expect(page.getByRole("heading", { name: "Who works on this with you?" })).toBeVisible();
  const orgNameInput = page.getByLabel("Organisation name");
  await expect(orgNameInput).toHaveValue("Private");
  await orgNameInput.fill(orgName);
  const inviteUrl = await createOnboardingInviteLink(page);
  await page.screenshot({ path: testInfo.outputPath("invite-step-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".ob-footer").getByRole("button", { name: "Go to board" })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("invite-step-phone.png"), fullPage: true });
  await page.setViewportSize(desktopViewport);
  await page.locator(".ob-footer").getByRole("button", { name: "Go to board" }).click();
  await expect(page).toHaveURL(/\/b\/[^/]+$/);
  await expectBoardLoaded(page, boardName);
  await expectExampleCards(page);
  await page.screenshot({ path: testInfo.outputPath("board-with-example-cards-desktop.png") });

  // The rename was saved, so the invite names the organisation rather than the placeholder.
  const { context, newcomer } = await openInviteAsNewcomer(browser, runtimeGuard, inviteUrl);
  try {
    await expect(newcomer.locator(".invite-banner")).toContainText(`You've been invited to join ${orgName}`);
  } finally {
    await context.close();
  }
  await page.reload();
  await expectBoardLoaded(page, boardName);
  await expect(page.locator("k-list .list-header h3").filter({ hasText: "In Progress" }))
    .toHaveAttribute("style", "--list-color: var(--color-blue);");
  await expect(page.locator("k-list .list-header h3").filter({ hasText: "Complete" }))
    .toHaveAttribute("style", "--list-color: var(--color-green);");
  await page.goto("/onboarding");
  // A standalone board remains independent: it does not turn hasWorkspace on.
  await expect(page.getByRole("heading", { name: "How do you want to start?" })).toBeVisible();
});
