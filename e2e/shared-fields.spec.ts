import { expect, test } from "./support/scenario";
import { boardHref, createCard, expectBoardLoaded, moveCardToBoard, openCard, workspaceSettingsHref } from "./support/ui";

test("unchanged custom field blurs do not count as edits", async ({ page, signIn, apiAs, testWorkspace, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const fieldResponse = await api.post(`/api/workspaces/${testWorkspace.id}/custom-fields`, {
    data: { name: "Branch", type: "text" },
  });
  expect(fieldResponse.ok()).toBe(true);
  const field = await fieldResponse.json() as { id: string };
  const title = uniqueName("Unchanged branch");
  const created = await api.post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")}/cards`, { data: { title } });
  expect(created.ok()).toBe(true);
  const card = await created.json() as { id: string };
  await signIn(page, "amelia", `/b/${testWorkspace.boardId}`);
  await expectBoardLoaded(page, testWorkspace.boardName);
  const detail = await openCard(page, title);
  const input = detail.locator(".cf-row").filter({ hasText: "Branch" }).locator("input.cf-input");
  const endpoint = `/api/cards/${card.id}/custom-fields/${field.id}`;
  const blur = async () => {
    await input.focus();
    const saved = page.waitForResponse((response) => response.url().endsWith(endpoint));
    await input.press("Tab");
    expect((await saved).ok()).toBe(true);
  };
  const activity = async () => {
    const feed = await (await api.get(`/api/boards/${testWorkspace.boardId}/activity`)).json() as {
      type: string; data: { id: string; payload: unknown; coalescedCount: number };
    }[];
    return feed.filter((item) => item.type === "activity").map(({ data }) => ({
      id: data.id, payload: data.payload, coalescedCount: data.coalescedCount,
    }));
  };
  const stored = async () => {
    const result = await (await api.get(`/api/cards/${card.id}/detail`)).json() as {
      card: { updatedAt: string }; customFieldValues: unknown[];
    };
    return { updatedAt: result.card.updatedAt, values: result.customFieldValues };
  };
  await input.fill("dev");
  await blur();
  const firstActivity = await activity();
  const firstStored = await stored();
  const row = detail.locator(".activity-item").filter({ hasText: "Branch" });
  await expect(row).toContainText("dev");
  for (let i = 0; i < 3; i++) {
    await blur();
    expect(await activity()).toEqual(firstActivity);
    expect(await stored()).toEqual(firstStored);
  }
  await page.screenshot({ path: testInfo.outputPath("unchanged-branch-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await blur();
  expect(await activity()).toEqual(firstActivity);
  await page.screenshot({ path: testInfo.outputPath("unchanged-branch-phone.png") });
  await input.fill("main");
  await blur();
  await expect(row).toContainText("2 times");
  await expect(row).toContainText("main");
  await input.fill("");
  await blur();
  const clearedActivity = await activity();
  const clearedStored = await stored();
  await blur();
  expect(await activity()).toEqual(clearedActivity);
  expect(await stored()).toEqual(clearedStored);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`card composer accepts fractional number fields at ${viewport.width}px`, async ({ page, signIn, apiAs, testWorkspace, uniqueName }, testInfo) => {
    const api = await apiAs("amelia");
    const field = await api.post(`/api/workspaces/${testWorkspace.id}/custom-fields`, {
      data: { name: "Billing Hours", type: "number" },
    });
    expect(field.ok(), await field.text()).toBe(true);
    await page.setViewportSize(viewport);
    await signIn(page, "amelia", `/b/${testWorkspace.boardId}`);
    await expectBoardLoaded(page, testWorkspace.boardName);
    await page.getByRole("button", { name: "New card", exact: true }).click();
    const composer = page.getByRole("dialog", { name: "New card" });
    const title = uniqueName("Half-hour capture");
    await composer.locator("textarea.cmp-title-input").fill(title);
    const hours = composer.getByRole("spinbutton", { name: "Billing Hours" });
    await hours.fill("0.5");
    await page.screenshot({ path: testInfo.outputPath("fractional-number-composer.png") });
    // Chromium's default integer step blocks native form submission before Angular sees it.
    expect(await hours.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(true);
    await composer.getByRole("button", { name: "Create card" }).click();
    await expect(composer).toBeHidden();
    await page.reload();
    await expectBoardLoaded(page, testWorkspace.boardName);
    const detail = await openCard(page, title);
    await expect(detail.locator(".cf-row").filter({ hasText: "Billing Hours" }).locator("input.cf-input")).toHaveValue("0.5");
    await page.screenshot({ path: testInfo.outputPath("fractional-number-persisted.png") });
  });
}

test("workspace field edits and card values survive a board transfer and work in the target filter", async ({ page, signIn, uniqueName }) => {
  const initialField = uniqueName("E2E source field");
  const field = `${initialField} renamed`;
  const value = uniqueName("E2E shared value");
  const title = uniqueName("E2E field card");
  await signIn(page, "amelia");
  const sourceHref = await boardHref(page, "E2E primary board");
  const targetHref = await boardHref(page, "E2E secondary board");
  const settingsHref = await workspaceSettingsHref(page, "E2E primary board");

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
  await expectBoardLoaded(page, "E2E primary board");
  await createCard(page, title);
  const detail = await openCard(page, title);
  const fieldRow = detail.locator(".cf-row").filter({ hasText: field });
  await expect(fieldRow).toBeVisible();
  await fieldRow.locator("input.cf-input").fill(value);
  await fieldRow.locator("input.cf-input").press("Enter");
  await expect(fieldRow.locator("input.cf-input")).toHaveValue(value);
  await moveCardToBoard(detail, "E2E secondary board");

  await page.goto(targetHref);
  await expectBoardLoaded(page, "E2E secondary board");
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
