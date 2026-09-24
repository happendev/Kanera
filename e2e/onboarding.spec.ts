import type { Page } from "@playwright/test";
import { SEED_PASSWORD, webOrigin } from "./support/env";
import { expect, test } from "./support/fixtures";
import { expectBoardLoaded, scrollBoardToEnd } from "./support/ui";

async function signUp(page: Page, name: string) {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@kanera.test`;
  await page.goto("/signup");
  await page.locator("#cname").fill(name);
  await page.locator("#dn").fill(name);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(SEED_PASSWORD);
  await page.locator("#confirm-password").fill(SEED_PASSWORD);
  await page.locator("form").getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/onboarding/);
}

test("signup creates a workspace whose lists and fields belong to a second board", async ({ page, uniqueName }) => {
  const workspaceName = uniqueName("E2E Workspace");
  const listName = uniqueName("E2E List");
  const fieldName = uniqueName("E2E Field");
  const secondBoard = uniqueName("E2E Second Board");

  await signUp(page, uniqueName("E2E workspace signup"));
  await page.locator(".ob-kind-option").filter({ hasText: "Create a workspace" }).click();
  await page.getByRole("button", { name: "Set up workspace" }).last().click();
  await page.locator(".ob-template-option").filter({ hasText: "Development Team" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator('input[name="name"]').fill(workspaceName);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("New list name").fill(listName);
  await page.getByRole("button", { name: "Add list" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("Field name").fill(fieldName);
  await page.getByRole("button", { name: "Add field" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.locator("k-app-shell")).toBeVisible();
  await expect(page).not.toHaveURL(/\/onboarding/);

  const firstBoard = page.locator("a.board-link").filter({ hasText: "Engineering" }).first();
  await expect(firstBoard).toBeVisible();
  await firstBoard.click();
  await expectBoardLoaded(page, "Engineering");
  await scrollBoardToEnd(page);
  await expect(page.locator("k-list").filter({ hasText: listName })).toHaveCount(1);
  const settingsHref = await page.locator("a.ws-settings").filter({ visible: true }).first().getAttribute("href");
  expect(settingsHref).toMatch(/^\/w\/[^/]+\/settings$/);
  await page.goto(`${settingsHref}/boards`);
  await page.getByPlaceholder("Board name").fill(secondBoard);
  await page.getByRole("button", { name: "Add board" }).click();
  const secondLink = page.locator("a.board-link").filter({ hasText: secondBoard }).first();
  await expect(secondLink).toBeVisible();
  await secondLink.click();
  await expectBoardLoaded(page, secondBoard);
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
});

test("signup can start with a standalone board without completing workspace onboarding", async ({ page, uniqueName }) => {
  const boardName = uniqueName("E2E Solo");
  await signUp(page, uniqueName("E2E standalone signup"));
  await page.locator(".ob-kind-option").filter({ hasText: "Create a board" }).click();
  await page.getByPlaceholder("e.g. Product launch").fill(boardName);
  await page.locator(".ob-footer").getByRole("button", { name: "Create board" }).click();
  await expect(page).toHaveURL(/\/b\/[^/]+$/);
  await expectBoardLoaded(page, boardName);
  await page.reload();
  await expectBoardLoaded(page, boardName);
  await page.goto("/onboarding");
  // A standalone board remains independent: it does not turn hasWorkspace on.
  await expect(page.getByRole("heading", { name: "How do you want to start?" })).toBeVisible();
});
