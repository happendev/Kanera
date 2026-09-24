import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { boardHref, expectBoardLoaded, openBoard } from "./support/ui";

/** A list's card drop container; `dl-<listId>` is the CDK drop-list id the board renders. */
function listCards(page: Page, listId: string): Locator {
  return page.locator(`[id="dl-${listId}"]`);
}

/** The given titles in the order their tiles render in the list; titles not in it are omitted. */
async function renderedOrder(page: Page, listId: string, titles: string[]): Promise<string[]> {
  const tiles = await listCards(page, listId).locator("k-card").allInnerTexts();
  return tiles.flatMap((text) => titles.filter((title) => text.includes(title)));
}

/**
 * Drags with real pointer events. The CDK needs movement past its 5px threshold before it starts a
 * drag, then intermediate moves so it can compute the sort position; a single jump would drop in
 * place. Mouse drags have no start delay (only touch waits 600ms, card-drag-scroll.ts).
 *
 * The pointer approaches the target from the side it should land on, the way a person lines up a
 * drop: CDK places the item by where the pointer enters a list, so a diagonal path that happens to
 * cross the lower half of the target first would legitimately land after it.
 */
async function dragCard(page: Page, card: Locator, target: Locator, side: "above" | "below") {
  const from = (await card.boundingBox())!;
  const to = (await target.boundingBox())!;
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  const endX = to.x + to.width / 2;
  const endY = side === "below" ? to.y + to.height * 0.8 : to.y + to.height * 0.2;
  const approachY = side === "below" ? to.y + to.height + 12 : to.y - 12;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 8, startY + 8, { steps: 4 });
  await page.mouse.move(startX, approachY, { steps: 15 });
  await page.mouse.move(endX, approachY, { steps: 15 });
  await page.mouse.move(endX, endY, { steps: 10 });
  const moved = page.waitForResponse((response) => /\/api\/cards\/[^/]+\/move$/.test(response.url()) && response.request().method() === "POST");
  await page.mouse.up();
  expect((await moved).ok()).toBe(true);
}

test("dragged cards reorder within and across lists for every viewer and after reload", async ({ page, signIn, pageAs, apiAs, uniqueName }) => {
  const first = uniqueName("E2E drag first");
  const second = uniqueName("E2E drag second");
  const titles = [first, second];
  await signIn(page, "amelia");
  const boardId = (await boardHref(page, "Platform Delivery")).split("/")[2]!;

  // Setup through the API: the subject is the drag, not card creation. Default placement is the
  // bottom of the list, so the two cards start adjacent and in creation order.
  const api = await apiAs("amelia");
  const board = await api.get(`/api/boards/${boardId}?includeCards=false`);
  const { lists } = (await board.json()) as { lists: { id: string; name: string }[] };
  const listId = (name: string) => lists.find((list) => list.name === name)!.id;
  const backlog = listId("Backlog");
  const wishlist = listId("Wishlist");
  for (const title of titles) {
    const created = await api.post(`/api/boards/${boardId}/lists/${backlog}/cards`, { data: { title } });
    expect(created.ok(), await created.text()).toBe(true);
  }

  const viewer = await pageAs("marcus");
  await openBoard(page, "Platform Delivery");
  await openBoard(viewer, "Platform Delivery");
  await expect.poll(() => renderedOrder(page, backlog, titles)).toEqual([first, second]);
  await expect.poll(() => renderedOrder(viewer, backlog, titles)).toEqual([first, second]);

  const tile = (p: Page, title: string) => p.locator("k-card").filter({ hasText: title });

  // Reorder inside one list: the viewer's copy only changes through the server's card:moved event.
  await dragCard(page, tile(page, first), tile(page, second), "below");
  await expect.poll(() => renderedOrder(page, backlog, titles)).toEqual([second, first]);
  await expect.poll(() => renderedOrder(viewer, backlog, titles)).toEqual([second, first]);

  // Move across lists, onto the top of Wishlist.
  const wishlistTop = listCards(page, wishlist).locator("k-card").first();
  await dragCard(page, tile(page, first), wishlistTop, "above");
  await expect.poll(() => renderedOrder(page, wishlist, titles)).toEqual([first]);
  await expect.poll(() => renderedOrder(viewer, wishlist, titles)).toEqual([first]);
  await expect.poll(() => renderedOrder(viewer, backlog, titles)).toEqual([second]);
  const wishlistTitles = await listCards(viewer, wishlist).locator("k-card").allInnerTexts();
  expect(wishlistTitles[0], "dropped above the first Wishlist card").toContain(first);

  // Positions are persisted server-side, not just held in either client's state.
  for (const p of [page, viewer]) {
    await p.reload();
    await expectBoardLoaded(p, "Platform Delivery");
    await expect.poll(() => renderedOrder(p, wishlist, titles)).toEqual([first]);
    await expect.poll(() => renderedOrder(p, backlog, titles)).toEqual([second]);
    expect((await listCards(p, wishlist).locator("k-card").allInnerTexts())[0]).toContain(first);
  }
});
