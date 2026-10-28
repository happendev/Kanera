import { expect, test } from "./support/scenario";
import { boardHref, cardTile, createCard, expectBoardLoaded, moveCardToBoard, openCard } from "./support/ui";

test("a card moved across lists and boards converges in Kanban and table", async ({ page, signIn, uniqueName }) => {
  const title = uniqueName("E2E moving card");
  await signIn(page, "amelia");
  const sourceHref = await boardHref(page, "E2E primary board");
  const targetHref = await boardHref(page, "E2E secondary board");
  await page.goto(sourceHref);
  await expectBoardLoaded(page, "E2E primary board");
  await createCard(page, title);

  const detail = await openCard(page, title);
  await detail.locator(".move-list-btn:visible").first().click();
  await detail.locator(".move-list-popover .move-list-option").filter({ hasText: "In Progress" }).click();
  await expect(detail.locator(".move-list-btn:visible").first()).toContainText("In Progress");
  await expect(detail.locator(".activity-item").filter({ hasText: "moved from" })).toHaveCount(1);

  await moveCardToBoard(detail, "E2E secondary board");
  await expect(cardTile(page, title)).toHaveCount(0);
  await page.goto(targetHref);
  await expectBoardLoaded(page, "E2E secondary board");
  await expect(page.locator("k-list").filter({ hasText: "In Progress" }).locator("k-card").filter({ hasText: title })).toHaveCount(1);
  await page.reload();
  await expectBoardLoaded(page, "E2E secondary board");
  await expect(cardTile(page, title)).toHaveCount(1);
  await page.getByRole("button", { name: "Table view" }).click();
  const row = page.locator("k-board-table-view .tv-row").filter({ hasText: title });
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-col="status"]')).toContainText("In Progress");
  await row.getByRole("button", { name: "Open card" }).click();
  const movedDetail = page.getByRole("dialog", { name: `Card detail: ${title}` });
  // The destination feed records the transfer once; the earlier list move belongs to the source board.
  await expect(movedDetail.locator(".activity-item").filter({ hasText: "moved from" })).toHaveCount(1);
});
