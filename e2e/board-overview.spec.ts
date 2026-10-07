import { expect, test } from "./support/fixtures";
import { boardHref, openBoard, workspaceSettingsHref } from "./support/ui";

test("board overview and portfolio show card counts without health verdicts or settings", async ({ page, signIn }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("kanera-theme", "dark"));
  await signIn(page, "amelia");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await openBoard(page, "Platform Delivery");
  const href = await boardHref(page, "Platform Delivery");
  const settingsHref = await workspaceSettingsHref(page, "Platform Delivery");
  const trigger = page.getByRole("button", { name: "Board overview", exact: true });
  await expect(trigger).toBeVisible();
  await expect(trigger).not.toHaveAttribute("data-risk");
  await trigger.click();
  const overview = page.getByRole("region", { name: "Board overview", exact: true });
  await expect(overview).toBeVisible();
  await expect(overview).not.toContainText(/On track|Needs attention|At risk|Automatic work-risk/);
  for (const label of ["Active", "Overdue", "Unassigned", "Inactive"]) {
    await expect(overview.getByRole("button", { name: new RegExp(label) })).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath("board-overview.png") });
  await overview.screenshot({ path: testInfo.outputPath("board-overview.jpg"), quality: 88 });
  await overview.getByRole("button", { name: /Portfolio/ }).click();
  await expect(page.getByRole("columnheader", { name: "Overdue", exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Work risk", exact: true })).toHaveCount(0);
  await expect(page.locator(".portfolio-health")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("portfolio.png") });
  const surface = await page.locator(".work-page").boundingBox();
  await page.screenshot({ path: testInfo.outputPath("portfolio-summary.jpg"), quality: 88, clip: surface! });
  await page.goto(`${settingsHref}/general`);
  await expect(page.getByText("Mark cards inactive after", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Show board health" })).toHaveCount(0);
  await expect(page.getByText("Board health", { exact: true })).toHaveCount(0);
  await page.goto("/settings/org");
  await expect(page.getByText("New workspace defaults", { exact: true })).toBeVisible();
  await expect(page.getByText("Show board health by default", { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(href);
  await expect(page.getByRole("heading", { level: 1, name: "Platform Delivery" })).toBeVisible();
  await trigger.click();
  await expect(overview).toBeVisible();
  const bounds = await overview.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await expect(overview.getByRole("button", { name: /Inactive/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("board-overview-mobile.png") });
});

test("overview filters retain overdue, unassigned and inactive drill-downs", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const boardName = uniqueName("E2E card counts");
  const workspaceName = uniqueName("E2E overview workspace");
  const created = await api.post("/api/workspaces", { data: {
    name: workspaceName, initialBoard: { name: boardName },
    listNames: ["To do", "Done"], customFields: [],
  } });
  expect(created.ok(), await created.text()).toBe(true);
  const workspace = await created.json() as { id: string; initialBoard: { id: string } };
  const boardId = workspace.initialBoard.id;
  const boardResponse = await api.get(`/api/boards/${boardId}?includeCards=false`);
  expect(boardResponse.ok()).toBe(true);
  const board = await boardResponse.json() as { lists: { id: string }[] };
  const me = await (await api.get("/api/me")).json() as { id?: string; user?: { id: string } };
  const ownerId = me.user?.id ?? me.id!;
  const titles = ["Overdue owned", "Unassigned backlog", "Completed owned"].map((title) => uniqueName(title));
  const ids: string[] = [];
  for (const [index, title] of titles.entries()) {
    const response = await api.post(`/api/boards/${boardId}/lists/${board.lists[0]!.id}/cards`, {
      data: { title, assigneeIds: index === 1 ? [] : [ownerId] },
    });
    expect(response.ok(), await response.text()).toBe(true);
    ids.push((await response.json() as { id: string }).id);
  }
  expect((await api.patch(`/api/cards/${ids[0]}`, { data: { dueDateLocalDate: "2020-01-01", dueDateSlot: "anyTime" } })).ok()).toBe(true);
  expect((await api.patch(`/api/cards/${ids[2]}/completion`, { data: { completed: true } })).ok()).toBe(true);
  await signIn(page, "amelia");
  await page.goto(`/w/${workspace.id}/settings/general`);
  await expect(page.getByRole("heading", { name: `${workspaceName} Settings`, exact: true })).toBeVisible();
  // Use the visible setting to make inactivity deterministic, without ageing data in SQL.
  const inactiveField = page.locator("label").filter({ hasText: "Mark cards inactive after" }).getByRole("spinbutton");
  const saved = page.waitForResponse((response) => response.url().endsWith(`/workspaces/${workspace.id}`) && response.request().method() === "PATCH" && response.ok());
  await inactiveField.fill("0");
  await inactiveField.blur();
  await saved;
  await page.reload();
  await expect(inactiveField).toHaveValue("0");
  await page.goto(`/b/${boardId}`);
  await expect(page.getByRole("heading", { level: 1, name: boardName })).toBeVisible();
  await page.getByRole("button", { name: "Board overview", exact: true }).click();
  const overview = page.getByRole("region", { name: "Board overview", exact: true });
  await expect(overview.getByRole("button", { name: "2 Active", exact: true })).toBeVisible();
  await expect(overview.getByRole("button", { name: "1 Overdue", exact: true })).toBeVisible();
  await expect(overview.getByRole("button", { name: "1 Unassigned", exact: true })).toBeVisible();
  await expect(overview.getByRole("button", { name: "2 Inactive", exact: true })).toBeVisible();
  const tiles = page.locator("k-card");
  await overview.getByRole("button", { name: "1 Overdue", exact: true }).click();
  await expect(tiles).toHaveCount(1);
  await expect(tiles).toContainText(titles[0]!);
  await overview.getByRole("button", { name: "1 Unassigned", exact: true }).click();
  await expect(tiles).toHaveCount(1);
  await expect(tiles).toContainText(titles[1]!);
  await overview.getByRole("button", { name: "2 Inactive", exact: true }).click();
  await expect(tiles).toHaveCount(2);
  await expect(tiles.filter({ hasText: titles[2]! })).toHaveCount(0);
  await overview.getByRole("button", { name: "2 Inactive", exact: true }).click();
  await expect(tiles).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath("overview-card-filters.png") });
});
