import type { Locator } from "@playwright/test";
import { expect, test } from "./support/scenario";
import { boardIdOf, openBoard, openCard } from "./support/ui";

// Items added one Enter at a time fold into a single "added N checklist items" activity row per
// checklist. The viewer's card was open before any add, so every assertion on it is realtime: the
// first add arriving as a new row, each later add updating that row in place.

function activityRows(detail: Locator, text: string | RegExp): Locator {
  return detail.locator(".activity-item").filter({ hasText: text });
}

test("checklist items added from card detail collapse into one live activity row per checklist", async ({ page, signIn, pageAs, apiAs, uniqueName }) => {
  const title = uniqueName("E2E checklist activity");
  const launch = uniqueName("Launch");
  const followUp = uniqueName("Follow-up");
  await signIn(page, "amelia");
  const api = await apiAs("amelia");
  const boardId = await boardIdOf(page, "E2E primary board");
  const board = (await (await api.get(`/api/boards/${boardId}?includeCards=false`)).json()) as { lists: { id: string; name: string }[] };
  const backlog = board.lists.find((list) => list.name === "Backlog")!;
  const created = await api.post(`/api/boards/${boardId}/lists/${backlog.id}/cards`, { data: { title } });
  expect(created.ok(), await created.text()).toBe(true);
  const cardId = ((await created.json()) as { id: string }).id;
  const checklistIds = new Map<string, string>();
  for (const checklistTitle of [launch, followUp]) {
    const checklist = await api.post(`/api/cards/${cardId}/checklists`, { data: { title: checklistTitle } });
    expect(checklist.ok(), await checklist.text()).toBe(true);
    checklistIds.set(checklistTitle, ((await checklist.json()) as { id: string }).id);
  }

  const viewer = await pageAs("marcus");
  await openBoard(viewer, "E2E primary board");
  const viewerDetail = await openCard(viewer, title);

  await openBoard(page, "E2E primary board");
  const detail = await openCard(page, title);
  const addItems = async (checklistTitle: string, texts: string[]) => {
    const checklist = detail.locator(`.checklist-block[data-checklist-id="${checklistIds.get(checklistTitle)}"]`);
    const input = checklist.getByPlaceholder("Add an item…");
    // The add form stays open after Enter for batch entry, so only open it when it is closed.
    if (!(await input.isVisible())) await checklist.getByRole("button", { name: "Add an item" }).click();
    for (const text of texts) {
      await input.fill(text);
      await input.press("Enter");
      await expect(checklist.getByText(text, { exact: true })).toBeVisible();
    }
  };

  await addItems(launch, ["Draft release note"]);
  await expect(activityRows(viewerDetail, "added checklist item Draft release note")).toHaveCount(1);

  const launchChecklist = detail.locator(`.checklist-block[data-checklist-id="${checklistIds.get(launch)}"]`);
  const nextItemInput = launchChecklist.getByPlaceholder("Add an item…");
  let releaseResponse!: () => void;
  const pendingResponse = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const endpoint = `/api/cards/${cardId}/checklists/${checklistIds.get(launch)}/items`;
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "POST" || (route.request().postDataJSON() as { text: string }).text !== "Tag the release") {
      await route.continue();
      return;
    }
    // Commit the item and deliver its realtime echo before its HTTP acknowledgement, matching CI.
    const response = await route.fetch();
    await pendingResponse;
    await route.fulfill({ response });
  });
  try {
    await addItems(launch, ["Tag the release"]);
    await nextItemInput.fill("Publish the build");
    const acknowledged = page.waitForResponse((response) => response.url().endsWith(endpoint)
      && response.request().method() === "POST" && (response.request().postDataJSON() as { text: string }).text === "Tag the release");
    releaseResponse();
    await (await acknowledged).finished();
    // Let the released fetch's signal update render before checking the next draft.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(nextItemInput).toHaveValue("Publish the build");
    await page.screenshot({ path: test.info().outputPath("next-checklist-draft-desktop.png") });
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(nextItemInput).toHaveValue("Publish the build");
    await nextItemInput.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("next-checklist-draft-phone.png") });
    if (viewport) await page.setViewportSize(viewport);
  } finally {
    releaseResponse();
  }
  await nextItemInput.press("Enter");
  await expect(launchChecklist.getByText("Publish the build", { exact: true })).toBeVisible();
  await addItems(followUp, ["Announce"]);

  for (const pane of [viewerDetail, detail]) {
    await expect(activityRows(pane, `added 3 checklist items to ${launch}`)).toHaveCount(1);
    await expect(activityRows(pane, "added checklist item Announce")).toHaveCount(1);
    // The first add's row was updated in place, not left beside the collapsed row.
    await expect(activityRows(pane, /added checklist item (Draft release note|Tag the release|Publish the build)/)).toHaveCount(0);
  }
  await viewer.screenshot({ path: test.info().outputPath("viewer-checklist-activity.png") });
});
