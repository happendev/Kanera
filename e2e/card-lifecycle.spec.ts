import { expect, test } from "./support/fixtures";
import { cardTile, expectBoardLoaded, openBoard, openCard } from "./support/ui";

// The whole-list archive and its Undo run the same archive transition as one card's archive: each
// card's own history records both, and another member's open board follows both live.
test("archiving a whole list records each card's history, and Undo restores the cards live", async ({ page, testWorkspace, signIn, pageAs, apiAs, uniqueName }) => {
  const api = await apiAs("amelia");
  const listId = testWorkspace.lists.get("Wishlist")!;
  const titles = [uniqueName("List archive first"), uniqueName("List archive second")];
  for (const title of titles) {
    const created = await api.post(`/api/boards/${testWorkspace.boardId}/lists/${listId}/cards`, { data: { title } });
    expect(created.ok(), await created.text()).toBe(true);
  }
  await signIn(page, "amelia", `/b/${testWorkspace.boardId}`);
  await expectBoardLoaded(page, testWorkspace.boardName);
  const member = await pageAs("marcus");
  await openBoard(member, testWorkspace.boardName);
  for (const title of titles) await expect(cardTile(member, title)).toBeVisible();

  const list = page.locator("k-list").filter({ hasText: "Wishlist" });
  // The list menu button is revealed on hover.
  await list.locator(".list-header").hover();
  await list.getByRole("button", { name: "List options" }).click();
  await page.getByRole("button", { name: "Archive all cards" }).click();
  for (const title of titles) {
    await expect(cardTile(page, title)).toHaveCount(0);
    await expect(cardTile(member, title)).toHaveCount(0);
  }

  // Undo previously sent archived:false to the bulk endpoint, which accepts only archived:true.
  const toast = page.locator(".toast").filter({ hasText: "Cards in Wishlist archived." });
  await toast.getByRole("button", { name: "Undo" }).click();
  for (const title of titles) {
    await expect(cardTile(page, title)).toBeVisible();
    await expect(cardTile(member, title)).toBeVisible();
  }

  const detail = await openCard(member, titles[0]!);
  // The leading word boundary keeps "unarchived this card" from also counting as an archive row.
  // No trailing one: the row's text runs straight into its timestamp ("…this card1m ago").
  await expect(detail.locator(".activity-item").filter({ hasText: /\barchived this card/ })).toHaveCount(1);
  await expect(detail.locator(".activity-item").filter({ hasText: /\bunarchived this card/ })).toHaveCount(1);
});
