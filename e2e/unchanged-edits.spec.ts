import { expect, test } from "./support/fixtures";
import { expectBoardLoaded, openCard } from "./support/ui";

test("unchanged card and checklist edits preserve activity and saved timestamps", async ({ page, signIn, apiAs, testWorkspace, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const title = uniqueName("Unchanged edits");
  const created = await api.post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")}/cards`, { data: { title } });
  expect(created.ok()).toBe(true);
  const card = await created.json() as { id: string };
  const cardPath = `/api/cards/${card.id}`;
  const checklistResponse = await api.post(`${cardPath}/checklists`, { data: { title: "Release" } });
  expect(checklistResponse.ok()).toBe(true);
  const checklist = await checklistResponse.json() as { id: string };
  const checklistPath = `${cardPath}/checklists/${checklist.id}`;
  const itemResponse = await api.post(`${checklistPath}/items`, { data: { text: "Draft" } });
  expect(itemResponse.ok()).toBe(true);
  const item = await itemResponse.json() as { id: string };
  const itemPath = `${checklistPath}/items/${item.id}`;
  const snapshot = async () => {
    const response = await api.get(`${cardPath}/detail`);
    expect(response.ok()).toBe(true);
    const detail = await response.json() as { card: { title: string; description: string | null; updatedAt: string }; checklists: unknown[] };
    const feedResponse = await api.get(`/api/boards/${testWorkspace.boardId}/activity`);
    expect(feedResponse.ok()).toBe(true);
    const feed = await feedResponse.json() as { type: string; data: { id: string; payload: unknown; coalescedCount: number } }[];
    return {
      title: detail.card.title, description: detail.card.description, updatedAt: detail.card.updatedAt,
      checklists: detail.checklists,
      activity: feed.filter((entry) => entry.type === "activity").map(({ data }) => ({ id: data.id, payload: data.payload, count: data.coalescedCount })),
    };
  };
  const patch = async (path: string, data: object) => {
    const response = await api.patch(path, { data });
    expect(response.ok(), await response.text()).toBe(true);
  };
  // Each genuine edit establishes a coalescing burst; a duplicate must not extend its count.
  for (const [path, data] of [
    [cardPath, { title: `${title} renamed` }],
    [cardPath, { description: "Release notes" }],
    [checklistPath, { title: "Launch" }],
    [itemPath, { text: "Publish" }],
    [itemPath, { description: "Check the notes" }],
  ] as const) {
    const before = await snapshot();
    await patch(path, data);
    const changed = await snapshot();
    expect(changed).not.toEqual(before);
    await patch(path, data);
    expect(await snapshot()).toEqual(changed);
  }
  // A mixed patch must still apply its changed field without counting the unchanged one.
  for (const [path, data] of [
    [cardPath, { title: `${title} mixed`, description: "Release notes" }],
    [itemPath, { text: "Publish", description: "Check the release notes" }],
  ] as const) {
    const before = await snapshot();
    await patch(path, data);
    const changed = await snapshot();
    expect(changed.activity.reduce((sum, entry) => sum + entry.count, 0))
      .toBe(before.activity.reduce((sum, entry) => sum + entry.count, 0) + 1);
  }
  // Both item aliases and selected-item batches use the same no-op policy.
  const saved = await snapshot();
  await patch(`${cardPath}/checklist-items/${item.id}`, { text: "Publish", description: "Check the release notes" });
  await patch(`${cardPath}/checklist-items`, { updates: [{ itemId: item.id, changes: { text: "Publish", description: "Check the release notes" } }] });
  expect(await snapshot()).toEqual(saved);
  await signIn(page, "amelia", `/b/${testWorkspace.boardId}`);
  await expectBoardLoaded(page, testWorkspace.boardName);
  const detail = await openCard(page, `${title} mixed`);
  await detail.locator(".description-viewer-wrap").click();
  const editor = detail.locator("k-description-editor");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toBeHidden();
  expect(await snapshot()).toEqual(saved);
  await page.screenshot({ path: testInfo.outputPath("unchanged-description-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("unchanged-description-phone.png") });
  await detail.locator(".checklist-item-text").filter({ hasText: "Publish" }).click();
  const itemPanel = detail.locator(".checklist-item-panel");
  await itemPanel.locator(".description-viewer-wrap").click();
  const itemEditor = itemPanel.locator("k-description-editor");
  await itemEditor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(itemEditor).toBeHidden();
  expect(await snapshot()).toEqual(saved);
  await page.screenshot({ path: testInfo.outputPath("unchanged-checklist-description-phone.png") });
  await itemPanel.getByRole("button", { name: "Back to card", exact: true }).click();
  // Editors represent a blank description as either null or an empty string.
  for (const path of [cardPath, itemPath]) {
    await patch(path, { description: null });
    const cleared = await snapshot();
    await patch(path, { description: "" });
    await patch(path, { description: null });
    expect(await snapshot()).toEqual(cleared);
  }
});
