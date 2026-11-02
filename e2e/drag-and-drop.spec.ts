import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { boardIdOf, expectBoardLoaded, openBoard } from "./support/ui";

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
  await holdCardOver(page, card, target, side);
  await releaseCard(page);
}

/** Starts a drag and parks the pointer over the target without releasing, so the test can act mid-drag. */
async function holdCardOver(page: Page, card: Locator, target: Locator, side: "above" | "below") {
  // Mouse coordinates do not scroll a tile into view like locator actions do.
  await target.scrollIntoViewIfNeeded();
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeInViewport();
  await expect(target).toBeInViewport();
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
}

async function releaseCard(page: Page) {
  const moved = page.waitForResponse((response) => /\/api\/cards\/[^/]+\/move$/.test(response.url()) && response.request().method() === "POST");
  await page.mouse.up();
  expect((await moved).ok()).toBe(true);
}

test("dragged cards reorder within and across lists for every viewer and after reload", async ({ page, testWorkspace, signIn, pageAs, apiAs, uniqueName }) => {
  const first = uniqueName("E2E drag first");
  const second = uniqueName("E2E drag second");
  const titles = [first, second];
  await signIn(page, "amelia");
  const boardId = await boardIdOf(page, testWorkspace.boardName);

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

  const target = await api.post(`/api/boards/${boardId}/lists/${wishlist}/cards`, { data: { title: uniqueName("Wishlist anchor") } });
  expect(target.ok(), await target.text()).toBe(true);

  const viewer = await pageAs("marcus");
  await openBoard(page, testWorkspace.boardName);
  await openBoard(viewer, testWorkspace.boardName);
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
    await expectBoardLoaded(p, testWorkspace.boardName);
    await expect.poll(() => renderedOrder(p, wishlist, titles)).toEqual([first]);
    await expect.poll(() => renderedOrder(p, backlog, titles)).toEqual([second]);
    expect((await listCards(p, wishlist).locator("k-card").allInnerTexts())[0]).toContain(first);
  }
});

/**
 * A teammate's change landing mid-drag must not move the lists under the pointer. CDK measured the
 * drop list when the drag started; a card inserted above the hover point shifts every tile down
 * while CDK still sorts against the old geometry, so the drop would commit one slot off from the
 * placeholder the person is looking at. The board holds realtime events for the duration of the
 * drag and converges with one refresh once the card is released.
 */
test("a teammate's card arriving mid-drag waits until the drop, which lands where it was aimed", async ({ page, testWorkspace, signIn, pageAs, apiAs, uniqueName }) => {
  const dragged = uniqueName("E2E mid-drag card");
  const anchor = uniqueName("E2E mid-drag anchor");
  const arriving = uniqueName("E2E mid-drag arrival");
  const titles = [dragged, anchor, arriving];
  await signIn(page, "amelia");
  const boardId = await boardIdOf(page, testWorkspace.boardName);

  const api = await apiAs("amelia");
  const board = await api.get(`/api/boards/${boardId}?includeCards=false`);
  const { lists } = (await board.json()) as { lists: { id: string; name: string }[] };
  const listId = (name: string) => lists.find((list) => list.name === name)!.id;
  const backlog = listId("Backlog");
  const wishlist = listId("Wishlist");
  for (const [list, title] of [[backlog, dragged], [wishlist, anchor]] as const) {
    const created = await api.post(`/api/boards/${boardId}/lists/${list}/cards`, { data: { title } });
    expect(created.ok(), await created.text()).toBe(true);
  }

  // Marcus is the fan-out witness: once his board shows the arrival, the server has emitted the
  // event, so Amelia's socket has it too.
  const viewer = await pageAs("marcus");
  await openBoard(page, testWorkspace.boardName);
  await openBoard(viewer, testWorkspace.boardName);
  await expect.poll(() => renderedOrder(page, wishlist, titles)).toEqual([anchor]);
  await expect.poll(() => renderedOrder(viewer, wishlist, titles)).toEqual([anchor]);

  const tile = (p: Page, title: string) => p.locator("k-card").filter({ hasText: title });

  // Amelia lines up a drop directly above the anchor and holds there.
  await holdCardOver(page, tile(page, dragged), tile(page, anchor), "above");

  // Marcus puts a new card at the top of the same list while she is still holding.
  const marcus = await apiAs("marcus");
  const arrived = await marcus.post(`/api/boards/${boardId}/lists/${wishlist}/cards`, { data: { title: arriving, atTop: true } });
  expect(arrived.ok(), await arrived.text()).toBe(true);
  await expect.poll(() => renderedOrder(viewer, wishlist, titles)).toEqual([arriving, anchor]);
  // Her board must not shift under the pointer: the arrival stays out of the DOM until she lets go.
  await page.waitForTimeout(300);
  await expect(tile(page, arriving)).toHaveCount(0);

  await releaseCard(page);

  // The drop lands where it was aimed (directly above the anchor), and the held arrival then shows.
  await expect.poll(() => renderedOrder(page, wishlist, titles)).toEqual([arriving, dragged, anchor]);
  await expect.poll(() => renderedOrder(viewer, wishlist, titles)).toEqual([arriving, dragged, anchor]);
  await expect.poll(() => renderedOrder(page, backlog, titles)).toEqual([]);

  await page.reload();
  await expectBoardLoaded(page, testWorkspace.boardName);
  await expect.poll(() => renderedOrder(page, wishlist, titles)).toEqual([arriving, dragged, anchor]);
});
