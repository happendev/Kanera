import { expect, test } from "./support/fixtures";
import { boardHref, createCard, expectBoardLoaded, moveCardToBoard, openCard, workspaceSettingsHref } from "./support/ui";

test("workspace field edits and card values survive a board transfer and work in the target filter", async ({ page, signIn, uniqueName }) => {
  const initialField = uniqueName("E2E source field");
  const field = `${initialField} renamed`;
  const value = uniqueName("E2E shared value");
  const title = uniqueName("E2E field card");
  await signIn(page, "amelia");
  const sourceHref = await boardHref(page, "Platform Delivery");
  const targetHref = await boardHref(page, "Mobile Experience");
  const settingsHref = await workspaceSettingsHref(page, "Platform Delivery");

  await page.goto(`${settingsHref}/fields`);
  await page.getByPlaceholder("Field name").fill(initialField);
  await page.getByRole("button", { name: "Add field" }).click();
  const fieldTile = page.locator(".cf-field-tile").filter({ hasText: initialField });
  await expect(fieldTile).toBeVisible();
  await fieldTile.locator("span.grow").click();
  await page.locator(".cf-field-tile input.inline-name-input").fill(field);
  await page.locator(".cf-field-tile input.inline-name-input").press("Enter");
  await expect(page.locator(".cf-field-tile").filter({ hasText: field })).toBeVisible();

  await page.goto(sourceHref);
  await expectBoardLoaded(page, "Platform Delivery");
  await createCard(page, title);
  const detail = await openCard(page, title);
  const fieldRow = detail.locator(".cf-row").filter({ hasText: field });
  await expect(fieldRow).toBeVisible();
  await fieldRow.locator("input.cf-input").fill(value);
  await fieldRow.locator("input.cf-input").press("Enter");
  await expect(fieldRow.locator("input.cf-input")).toHaveValue(value);
  await moveCardToBoard(detail, "Mobile Experience");

  await page.goto(targetHref);
  await expectBoardLoaded(page, "Mobile Experience");
  await page.getByRole("button", { name: "Table view" }).click();
  const row = page.locator("k-board-table-view .tv-row").filter({ hasText: title });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(value);
  await page.reload();
  await expect(row).toContainText(value);
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.locator(".fb-row").filter({ hasText: "Custom fields" }).click();
  await page.locator(".fb-row").filter({ hasText: field }).click();
  await page.getByPlaceholder("Value").fill(value);
  await expect(row).toHaveCount(1);
  await page.getByPlaceholder("Value").fill(`${value}-no-match`);
  await expect(row).toHaveCount(0);
});
