import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "./support/fixtures";
import { cardTile, createCard, expectBoardLoaded, expectCardTileMounted, openBoard } from "./support/ui";

// The hover strip between two lane items offers "add card" and "add separator" at that exact spot.
// The separator must be created with an `afterItem` anchor (not appended to the lane), arrive
// coloured with the board's accent without opening a title editor, reach another viewer in the same
// position, and keep that position after a reload.
test("a separator inserted between two cards lands there for every viewer", async ({ page, testWorkspace, signIn, pageAs, uniqueName }) => {
  const first = uniqueName("E2E insert above");
  const second = uniqueName("E2E insert below");
  await signIn(page, "amelia");
  const member = await pageAs("marcus");
  await openBoard(page, testWorkspace.boardName);
  await openBoard(member, testWorkspace.boardName);

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
  // The owned board's colour is blue, which outranks the workspace accent.
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
  await expectBoardLoaded(page, testWorkspace.boardName);
  await expectCardTileMounted(page, first);
  await expect.poll(() => itemAfter(page, first)).toBe("coloured separator");

  await firstTile.scrollIntoViewIfNeeded();
  await strip.hover();
  await page.screenshot({ path: test.info().outputPath("lane-insert-strip.png") });
});

// Legacy cross-board positions can tie, but today's API/import paths deliberately avoid creating
// ties. Set up that historical state directly in the isolated E2E database, on test-owned cards
// only. The mutation under test still travels through the UI/API and must rebalance all neighbours.
test("a card inserted between two tied cross-board cards in My Cards lands there", async ({ page, testWorkspace, apiAs, signIn, uniqueName }) => {
  const api = await apiAs("amelia");
  const me = await (await api.get("/api/me")).json() as { id: string };
  const boardIds = [testWorkspace.boardId];
  for (const index of [2, 3]) boardIds.push(await testWorkspace.addBoard(uniqueName(`Tied board ${index}`)));
  const cardIds: string[] = [];
  for (const [index, boardId] of boardIds.entries()) {
    const created = await api.post(`/api/boards/${boardId}/lists/${testWorkspace.lists.get("Backlog")}/cards`, {
      data: { title: uniqueName(`Tied card ${index}`), assigneeIds: [me.id] },
    });
    expect(created.ok(), await created.text()).toBe(true);
    cardIds.push((await created.json() as { id: string }).id);
  }
  for (const id of cardIds) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  const output = execFileSync("docker", [
    "compose", "-p", "kanera-e2e", "-f", path.join(__dirname, "../docker-compose.e2e.yml"),
    "exec", "-T", "postgres", "psql", "-U", "kanera_test", "-d", "kanera_test_e2e", "-v", "ON_ERROR_STOP=1", "-At", "-c",
    `UPDATE card SET position = 1000 WHERE id IN (${cardIds.map((id) => `'${id}'`).join(",")}) RETURNING id`,
  ], { encoding: "utf8", timeout: 10_000 });
  expect(output).toContain("UPDATE 3");
  const title = uniqueName("E2E My Cards insert");
  await signIn(page, "amelia", "/my-cards");
  await page.getByRole("button", { name: "Board view" }).click();
  const lane = page
    .locator("section.workspace-board")
    .filter({ hasText: testWorkspace.name })
    .locator("k-list")
    .filter({ hasText: "Backlog" });
  await expect(lane.locator("k-card")).toHaveCount(3);

  const laneTitles = () => lane.locator("k-card .card-title-text").allInnerTexts();
  const before = await laneTitles();
  const below = before[1]!;
  const opened = await api.post(`/api/boards/${boardIds[0]}/open`);
  expect((await opened.json() as { cards: { position: string }[] }).cards[0]!.position).toBe("1000.0000000000");

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
