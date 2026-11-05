import { expect, test } from "./support/scenario";
import { boardHref, cardTile, createCard, expectBoardLoaded, moveCardToBoard, moveCardToList, openCard } from "./support/ui";

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
  // The default table groups by list and hides Status; the row's group names its list.
  const group = page.locator("k-board-table-view .tv-run").filter({ hasText: title });
  await expect(group.locator(".tv-run-head")).toContainText("In Progress");
  await row.getByRole("button", { name: "Open card" }).click();
  const movedDetail = page.getByRole("dialog", { name: `Card detail: ${title}` });
  // The destination feed records the transfer once; the earlier list move belongs to the source board.
  await expect(movedDetail.locator(".activity-item").filter({ hasText: "moved from" })).toHaveCount(1);
});

type MoveNotification = {
  id: string;
  cardId: string | null;
  activity: { action: string; payload: { fromListId?: string; toListId?: string } } | null;
};

test("rapid list reversals clean activity and notifications while forward moves stay separate", async ({ page, signIn, pageAs, apiAs, testWorkspace, uniqueName }) => {
  const api = await apiAs("amelia");
  const watcherApi = await apiAs("marcus");
  const boardId = testWorkspace.boardId;
  const listId = (name: string) => testWorkspace.lists.get(name)!;
  const title = uniqueName("E2E rapid list moves");
  const created = await api.post(`/api/boards/${boardId}/lists/${listId("Backlog")}/cards`, { data: { title } });
  expect(created.ok(), await created.text()).toBe(true);
  const { id: cardId } = await created.json() as { id: string };
  expect((await watcherApi.put(`/api/cards/${cardId}/watch`)).ok()).toBe(true);

  const viewer = await pageAs("marcus");
  await viewer.goto(`/b/${boardId}`);
  const viewerDetail = await openCard(viewer, title);
  const inbox = await pageAs("marcus");
  await inbox.getByRole("button", { name: /^Notifications/ }).click();
  // Viewing the card in Marcus's other session can mark its notifications read.
  await inbox.getByRole("group", { name: "Read state" }).getByRole("button", { name: "All" }).click();
  const notice = inbox.locator(".notif-item").filter({ hasText: title });
  const moves = viewerDetail.locator(".activity-item").filter({ hasText: "moved from" });
  const savedMoves = async () => {
    const response = await watcherApi.get("/api/notifications?includeRead=true&limit=100");
    expect(response.ok()).toBe(true);
    const { items } = await response.json() as { items: MoveNotification[] };
    return items.filter((row) => row.cardId === cardId && row.activity?.action === "moved");
  };
  const bulkMove = async (name: string) => {
    const response = await api.post(`/api/boards/${boardId}/cards/bulk/move`, { data: { cardIds: [cardId], listId: listId(name) } });
    expect(response.ok(), await response.text()).toBe(true);
  };

  await signIn(page, "amelia", `/b/${boardId}`);
  const detail = await openCard(page, title);
  await moveCardToList(detail, "In Progress");
  await expect(moves).toHaveCount(1);
  await expect(notice).toHaveCount(1);
  await expect.poll(async () => (await savedMoves()).length).toBe(1);
  const firstNoticeId = (await savedMoves())[0]!.id;

  // Forward transitions remain distinct, including when mixing individual and bulk moves.
  await bulkMove("Ready for QA");
  await expect(moves).toHaveCount(2);
  await expect(notice.locator(".notif-action")).toHaveCount(2);
  await expect.poll(async () => (await savedMoves()).length).toBe(2);
  expect((await savedMoves()).map((row) => [row.activity?.payload.fromListId, row.activity?.payload.toListId]))
    .toEqual(expect.arrayContaining([[listId("Backlog"), listId("In Progress")], [listId("In Progress"), listId("Ready for QA")]]));

  // Undo just the last transition; the earlier forward move and its notification survive.
  await moveCardToList(detail, "In Progress");
  await expect(moves).toHaveCount(1);
  await expect(moves).toContainText("Backlog");
  await expect(moves).toContainText("In Progress");
  await expect(moves).not.toContainText("Ready for QA");
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText("In Progress");
  await expect.poll(async () => (await savedMoves()).map((row) => [row.id, row.activity?.payload.fromListId, row.activity?.payload.toListId]))
    .toEqual([[firstNoticeId, listId("Backlog"), listId("In Progress")]]);
  await viewer.screenshot({ path: test.info().outputPath("reversed-list-moves-desktop.png") });
  await viewer.setViewportSize({ width: 390, height: 844 });
  await viewerDetail.getByRole("button", { name: "Activity", exact: true }).click();
  await moves.scrollIntoViewIfNeeded();
  await viewer.screenshot({ path: test.info().outputPath("reversed-list-moves-phone.png") });

  await moveCardToList(detail, "Backlog");
  await expect(moves).toHaveCount(0);
  await expect(notice).toHaveCount(0);
  await expect.poll(async () => (await savedMoves()).length).toBe(0);

  // A new edit after the cancellation starts a fresh visible story, which bulk undo removes too.
  await bulkMove("Wishlist");
  await expect(moves).toHaveCount(1);
  await expect(notice).toHaveCount(1);
  await expect.poll(async () => (await savedMoves()).length).toBe(1);
  expect((await savedMoves())[0]!.id).not.toBe(firstNoticeId);
  await bulkMove("Backlog");
  await expect(moves).toHaveCount(0);
  await expect(notice).toHaveCount(0);
  await expect.poll(async () => (await savedMoves()).length).toBe(0);
  await viewer.reload();
  const reloadedDetail = viewer.getByRole("dialog", { name: `Card detail: ${title}` });
  await expect(reloadedDetail).toBeVisible();
  await reloadedDetail.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(reloadedDetail.locator(".activity-item").filter({ hasText: "created this card" })).toBeVisible();
  await expect(reloadedDetail.locator(".activity-item").filter({ hasText: "moved from" })).toHaveCount(0);
});
