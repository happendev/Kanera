import { expect, test } from "./support/scenario";

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
  await page.setViewportSize({ width: 390, height: 844 });
  // Resizing schedules responsive layout and panel placement asynchronously. Read the settled
  // bounds rather than asserting against the desktop geometry in the first frame after resize.
  await expect.poll(async () => {
    const bounds = await overview.boundingBox();
    return bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= 390;
  }).toBe(true);
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
