import { expect, test } from "./support/fixtures";
import { cardTile, createCard, expectBoardLoaded, openBoard, scrollBoardToEnd, workspaceSettingsHref } from "./support/ui";

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

test("workspace lists reach another board without a refresh", async ({ page, testWorkspace, signIn, pageAs, uniqueName }) => {
  const name = uniqueName("E2E shared list");
  await signIn(page, "amelia");
  const member = await pageAs("marcus");
  const otherBoard = uniqueName("Other board");
  await testWorkspace.addBoard(otherBoard);
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
