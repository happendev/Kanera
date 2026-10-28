import { expect, test } from "./support/fixtures";
import { cardTile, createCard, expectBoardLoaded, expectCardTileMounted, openBoard, scrollBoardToEnd, workspaceSettingsHref } from "./support/ui";

test("a created card reaches another workspace member and survives reload", async ({ page, testWorkspace, signIn, pageAs, uniqueName }) => {
  const title = uniqueName("E2E live card");
  await signIn(page, "amelia");
  const member = await pageAs("marcus");
  await openBoard(page, testWorkspace.boardName);
  await openBoard(member, testWorkspace.boardName);

  await createCard(page, title);

  // The second browser is already on the board: this assertion exercises room delivery, not a reload.
  await expect(cardTile(member, title)).toBeVisible();
  await member.reload();
  await expectBoardLoaded(member, testWorkspace.boardName);
  await expect(cardTile(member, title)).toBeVisible();
});

test("a live card beyond the lane render cap appears when scrolled and survives reload", async ({ page, testWorkspace, signIn, apiAs, uniqueName }) => {
  const api = await apiAs("amelia");
  const listId = testWorkspace.lists.get("Backlog")!;
  const endpoint = `/api/boards/${testWorkspace.boardId}/lists/${listId}/cards`;
  // Exceed both the initial 15 tiles and the 60-tile page that short cards can eagerly fill.
  // Own this volume so the scenario actually exercises incremental mounting and live state.
  const existingTitles = Array.from({ length: 80 }, (_, index) => uniqueName(`Existing card ${index}`));
  for (const title of existingTitles) {
    const created = await api.post(endpoint, { data: { title } });
    expect(created.ok(), await created.text()).toBe(true);
  }
  await signIn(page, "marcus", `/b/${testWorkspace.boardId}`);
  await expectBoardLoaded(page, testWorkspace.boardName);
  await expect(cardTile(page, existingTitles[0]!)).toBeVisible();
  await expect(cardTile(page, existingTitles.at(-1)!)).toHaveCount(0);

  const title = uniqueName("Beyond render cap");
  const created = await api.post(endpoint, { data: { title } });
  expect(created.ok(), await created.text()).toBe(true);
  await expectCardTileMounted(page, title, listId);
  await expect(cardTile(page, title)).toBeVisible();
  await page.reload();
  await expectBoardLoaded(page, testWorkspace.boardName);
  await expectCardTileMounted(page, title, listId);
  await expect(cardTile(page, title)).toBeVisible();
});

test("workspace lists reach another board without a refresh", async ({ page, testWorkspace, signIn, pageAs, uniqueName }) => {
  const name = uniqueName("E2E shared list");
  // This test covers list fanout. Set up both boards before the sidebars load, so opening the
  // target cannot race the initial board catalogue and the board-created subscription.
  const otherBoard = uniqueName("Other board");
  await testWorkspace.addBoard(otherBoard);
  await signIn(page, "amelia");
  const member = await pageAs("marcus");
  await openBoard(member, otherBoard);

  const settingsHref = await workspaceSettingsHref(page, testWorkspace.boardName);
  await page.goto(`${settingsHref}/lists`);
  await page.getByPlaceholder("List name").fill(name);
  await page.getByRole("button", { name: "Add list" }).click();
  await expect(page.getByRole("button", { name: `Rename ${name}` })).toBeVisible();

  // The member stays on a different board. This checks workspace room fanout and board state.
  await scrollBoardToEnd(member);
  await expect(member.locator("k-list .list-header h3").filter({ hasText: name })).toBeVisible();
  await member.reload();
  await expectBoardLoaded(member, otherBoard);
  await scrollBoardToEnd(member);
  await expect(member.locator("k-list .list-header h3").filter({ hasText: name })).toBeVisible();
});
