import type { APIResponse } from "@playwright/test";
import type { BoardMirrorRow, CardMirrorStatus } from "../packages/shared/src/dto/board-mirrors";
import { expandCardSummary, type CompactCardSummary, type WireCardDetail } from "../packages/shared/src/events";
import { expect, test } from "./support/fixtures";
import { expectBoardLoaded } from "./support/ui";

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as T;
}

// Missing mappings, unlinked lookalike copies, lost source discussion/files and reversed client
// access are concrete seed failures. Read the real fixtures after the real worker reconciles them.
test("the seed adds a client-to-internal sync with complete discussion and files", async ({ page, apiAs, signIn }, testInfo) => {
  const api = await apiAs("amelia");
  const boards = await json<{ id: string; name: string }[]>(await api.get("/api/boards"));
  const source = boards.find((board) => board.name === "Northstar — Client Feedback")!;
  const target = boards.find((board) => board.name === "Northstar Internal")!;
  expect(source).toBeTruthy();
  expect(target).toBeTruthy();
  // Keep both showcase boards, but remove the unrelated launch-to-delivery relationship.
  for (const name of ["Launch Checklist", "Platform Delivery", "Customer Portal Revamp"]) {
    expect(boards.some((board) => board.name === name), name).toBe(true);
  }
  const original = boards.find((board) => board.name === "Launch Checklist")!;
  expect(await json<BoardMirrorRow[]>(await api.get(`/api/boards/${original.id}/outbound-mirrors`))).toEqual([]);
  const platform = boards.find((board) => board.name === "Platform Delivery")!;
  expect(await json<BoardMirrorRow[]>(await api.get(`/api/boards/${platform.id}/mirrors`)))
    .not.toContainEqual(expect.objectContaining({ sourceBoardId: original.id }));

  const mirrorRows = () => api.get(`/api/boards/${source.id}/outbound-mirrors`).then(json<BoardMirrorRow[]>);
  await expect.poll(async () => (await mirrorRows())[0]?.reconcileRequestedAt).toBeNull();
  const [mirror] = await mirrorRows();
  expect(mirror).toMatchObject({ sourceBoardId: source.id, targetBoardId: target.id, pausedAt: null, lastError: null });
  expect(mirror!.lastSyncAt).toBeTruthy();
  expect(mirror!.lists.map((row) => [row.sourceListName, row.targetListName])).toEqual(expect.arrayContaining([
    ["Approved for development", "Backlog"], ["In delivery", "In Progress"],
    ["Client review", "Ready for QA"], ["Accepted", "Done"],
  ]));
  expect(mirror!.lists).toHaveLength(4);

  const open = async (id: string) => {
    const opened = await json<{ cards: CompactCardSummary[]; lists: { id: string; name: string }[] }>(
      await api.post(`/api/boards/${id}/open?includeCompleted=true`));
    return { ...opened, cards: opened.cards.map(expandCardSummary) };
  };
  const sourceBoard = await open(source.id);
  await expect.poll(async () => (await open(target.id)).cards.length).toBe(8);
  const targetBoard = await open(target.id);
  expect(sourceBoard.cards).toHaveLength(8);
  const mappings = new Map(mirror!.lists.map((row) => [row.sourceListId, row.targetListId]));
  const evidence = [];
  for (const card of sourceBoard.cards) {
    const status = await json<CardMirrorStatus>(await api.get(`/api/cards/${card.id}/mirrors`));
    const targetListId = mappings.get(card.listId);
    if (!targetListId) {
      expect(status.asSource, card.title).toEqual([]);
      expect(targetBoard.cards.filter((candidate) => candidate.title === card.title)).toEqual([]);
      continue;
    }
    expect(status.asSource, card.title).toHaveLength(1);
    const copy = targetBoard.cards.find((candidate) => candidate.id === status.asSource[0]!.cardId)!;
    expect(copy).toMatchObject({ title: card.title, listId: targetListId });
    expect(Boolean(copy.completedAt), card.title).toBe(Boolean(card.completedAt));
    const detail = await json<WireCardDetail>(await api.get(`/api/cards/${card.id}/detail`));
    const copiedDetail = await json<WireCardDetail>(await api.get(`/api/cards/${copy.id}/detail`));
    expect(copiedDetail.card.description).toBe(detail.card.description);
    expect(copiedDetail.attachments.map((file) => file.fileName).sort()).toEqual(detail.attachments.map((file) => file.fileName).sort());
    for (const file of detail.attachments) {
      const copiedFile = copiedDetail.attachments.find((candidate) => candidate.fileName === file.fileName)!;
      expect(copiedFile.id).not.toBe(file.id);
      const originalBytes = await api.get(file.url);
      const copiedBytes = await api.get(copiedFile.url);
      expect(originalBytes.ok()).toBe(true);
      expect(copiedBytes.ok()).toBe(true);
      expect(await copiedBytes.body()).toEqual(await originalBytes.body());
    }
    const feed = await json<{ items: { type: string; data: { body?: string } }[] }>(await api.get(`/api/cards/${card.id}/feed?limit=100`));
    const copiedFeed = await json<typeof feed>(await api.get(`/api/cards/${copy.id}/feed?limit=100`));
    for (const comment of feed.items.filter((item) => item.type === "comment")) {
      expect(copiedFeed.items.some((item) => item.type === "comment" && item.data.body?.includes(comment.data.body!)), card.title).toBe(true);
    }
    evidence.push({ source: detail, copy: copiedDetail, feed, copiedFeed });
  }
  const maya = await apiAs("maya");
  expect((await maya.post(`/api/boards/${source.id}/open`)).ok()).toBe(true);
  expect((await maya.post(`/api/boards/${target.id}/open`)).status()).toBe(403);
  await testInfo.attach("seed-board-sync-readback", { body: JSON.stringify({ mirror, evidence }, null, 2), contentType: "application/json" });

  await signIn(page, "amelia", `/b/${source.id}`);
  await expectBoardLoaded(page, source.name);
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("client-feedback-desktop.png") });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("client-feedback-phone.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/b/${target.id}`);
  await expectBoardLoaded(page, target.name);
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("internal-delivery-desktop.png") });
  const bug = targetBoard.cards.find((card) => card.title === "Billing export repeats invoices when a customer has two contacts")!;
  await page.goto(`/b/${target.id}/c/${bug.id}`);
  const dialog = page.getByRole("dialog", { name: `Card detail: ${bug.title}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("li.attach-row")).toHaveCount(2);
  await expect(dialog.locator(".comment").filter({ hasText: "One more detail from finance" })).toHaveCount(1);
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("synced-bug-desktop.png") });
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(dialog).toBeVisible();
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("synced-bug-phone.png") });
  await dialog.locator(".col-tabs").getByRole("button", { name: /Activity/ }).click();
  const clientReply = dialog.locator(".comment").filter({ hasText: "One more detail from finance" });
  await expect(clientReply).toBeVisible();
  await clientReply.scrollIntoViewIfNeeded();
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("synced-discussion-phone.png") });
});
