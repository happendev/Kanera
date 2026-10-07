import { expect, test } from "./support/fixtures";
import { cardTile, createCard, expectBoardLoaded, expectCardTileMounted, openBoard } from "./support/ui";

// The hover strip between two lane items offers "add card" and "add separator" at that exact spot.
// The separator must be created with an `afterItem` anchor (not appended to the lane), arrive
// coloured with the board's accent without opening a title editor, reach another viewer in the same
// position, and keep that position after a reload.
test("a separator inserted between two cards lands there for every viewer", async ({ page, signIn, pageAs, uniqueName }) => {
  const first = uniqueName("E2E insert above");
  const second = uniqueName("E2E insert below");
  await signIn(page, "amelia");
  const member = await pageAs("marcus");
  await openBoard(page, "Platform Delivery");
  await openBoard(member, "Platform Delivery");

  await createCard(page, first);
  await createCard(page, second);

  const firstTile = cardTile(page, first);
  // The strip is the lane child directly after the first card. Only hovering opens it.
  const strip = firstTile.locator("xpath=following-sibling::*[1][contains(@class, 'lane-insert')]");
  await strip.hover();
  const createResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && /\/boards\/[^/]+\/lists\/[^/]+\/separators$/.test(new URL(response.url()).pathname),
  );
  await strip.getByRole("button", { name: "Add separator here" }).click();
  const response = await createResponse;
  const body = response.request().postDataJSON() as { afterItem?: { type: string; id: string }; atTop?: boolean; color?: string | null };
  expect(body.afterItem?.type).toBe("card");
  expect(body.atTop).toBeUndefined();
  // The seeded Platform Delivery board's own colour is blue, which outranks the workspace accent.
  expect(body.color, "new separators take the board accent").toBe("blue");
  expect((await response.json() as { color: string | null }).color).toBe("blue");

  // Added ready-made: no title editor opens.
  await expect(page.getByPlaceholder("Separator title")).toHaveCount(0);

  const itemAfter = async (viewer: typeof page, title: string) =>
    cardTile(viewer, title).evaluate((tile) => {
      // Skip the insert strip; the next lane item is a k-card or k-separator.
      let next = tile.nextElementSibling;
      while (next && next.tagName !== "K-CARD" && next.tagName !== "K-SEPARATOR") next = next.nextElementSibling;
      if (next?.tagName !== "K-SEPARATOR") return null;
      return next.querySelector(".separator.has-color") ? "coloured separator" : "uncoloured separator";
    });

  await expect.poll(() => itemAfter(page, first)).toBe("coloured separator");
  await expectCardTileMounted(member, first);
  await expect.poll(() => itemAfter(member, first)).toBe("coloured separator");

  await page.reload();
  await expectBoardLoaded(page, "Platform Delivery");
  await expectCardTileMounted(page, first);
  await expect.poll(() => itemAfter(page, first)).toBe("coloured separator");

  await firstTile.scrollIntoViewIfNeeded();
  await strip.hover();
  await page.screenshot({ path: test.info().outputPath("lane-insert-strip.png") });
});

// Card positions are only unique per board, so seeded cards from different boards share positions
// (each board numbers its lane from the same step). In a merged Global Work lane the midpoint of two
// tied neighbours equals both, and the new card used to sort after every tied card instead of
// landing where it was inserted. The seeded lane below holds such ties; it cannot be rebuilt through
// the API because every app insert path already picks workspace-unique positions.
test("a card inserted between two tied cross-board cards in My Cards lands there", async ({ page, signIn, uniqueName }) => {
  const above = "Approve the campaign launch package";
  const below = "Review the updated colour guidance";
  const title = uniqueName("E2E My Cards insert");
  await signIn(page, "amelia");
  await page.goto("/my-cards");
  await page.getByRole("button", { name: "Board view" }).click();
  const lane = page
    .locator("section.workspace-board")
    .filter({ hasText: "Marketing & Creative" })
    .locator("k-list")
    .filter({ hasText: "Review & Approval" });
  await expect(lane.locator("k-card").filter({ hasText: below })).toBeVisible();

  const laneTitles = () => lane.locator("k-card .card-title-text").allInnerTexts();
  const before = await laneTitles();
  expect(before.indexOf(below), "seed lane keeps the two cards adjacent").toBe(before.indexOf(above) + 1);

  // The strip directly above the lower card is the "between" insert point.
  const strip = lane.locator("k-card").filter({ hasText: below }).locator("xpath=preceding-sibling::*[1][contains(@class, 'lane-insert')]");
  await strip.hover();
  await strip.getByRole("button", { name: "Add card here" }).click();
  const composer = page.getByRole("dialog", { name: "New card" });
  await composer.locator("textarea.cmp-title-input").fill(title);
  const createRequest = page.waitForRequest((request) =>
    request.method() === "POST" && /\/boards\/[^/]+\/lists\/[^/]+\/cards$/.test(new URL(request.url()).pathname),
  );
  await composer.getByRole("button", { name: "Create card" }).click();
  const body = (await createRequest).postDataJSON() as { afterItem?: { type: string }; globalWorkUserId?: string };
  expect(body.afterItem?.type).toBe("card");
  expect(body.globalWorkUserId).toBeTruthy();
  await expect(composer).toBeHidden();

  // The new card sits between its two neighbours, and the rebalance that made room for it did not
  // reorder anything else in the merged lane.
  const expected = [...before.slice(0, before.indexOf(below)), title, ...before.slice(before.indexOf(below))];
  await expect.poll(laneTitles).toEqual(expected);

  await page.reload();
  await expect(lane.locator("k-card").filter({ hasText: title })).toBeVisible();
  await expect.poll(laneTitles).toEqual(expected);
  await lane.screenshot({ path: test.info().outputPath("my-cards-lane-insert.png") });
});
