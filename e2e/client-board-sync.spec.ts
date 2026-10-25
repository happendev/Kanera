import type { APIResponse } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { openCard, cardTile, expectBoardLoaded } from "./support/ui";

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as T;
}

// Use owned fixtures for live writes: a broken copy loop, stale source edits or a lost internal
// note must be caught without changing the curated recording boards for later seed checks.
test("client comments and files arrive live while delivery discussion stays internal", async ({ page, apiAs, signIn, testWorkspace, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const targetName = uniqueName("Internal delivery");
  const targetId = await testWorkspace.addBoard(targetName);
  const listId = testWorkspace.lists.get("Backlog")!;
  await json(await api.post(`/api/boards/${testWorkspace.boardId}/mirrors`, {
    data: { targetBoardId: targetId, lists: [{ sourceListId: listId, targetListId: listId }] },
  }));
  await signIn(page, "amelia", `/b/${targetId}`);
  await expectBoardLoaded(page, targetName);
  const title = uniqueName("Billing export duplicates invoice rows");
  const source = await json<{ id: string }>(await api.post(`/api/boards/${testWorkspace.boardId}/lists/${listId}/cards`, { data: { title } }));
  await expect(cardTile(page, title)).toHaveCount(1);
  const dialog = await openCard(page, title);
  const commentBody = "Finance confirms the tax column is duplicated too. Please check the revised example.";
  const comment = await json<{ id: string }>(await api.post(`/api/cards/${source.id}/comments`, { data: { body: commentBody } }));
  await expect(dialog.locator(".comment").filter({ hasText: commentBody })).toHaveCount(1);
  const fileName = "northstar-revised-export.csv";
  const bytes = Buffer.from("invoice_number,net,tax,gross\nNS-1048,1200.00,240.00,1440.00\n");
  await json(await api.post(`/api/cards/${source.id}/attachments`, {
    multipart: { file: { name: fileName, mimeType: "text/csv", buffer: bytes } },
  }));
  await expect(dialog.locator("li.attach-row").filter({ hasText: fileName })).toHaveCount(1);
  const targetBoard = await json<{ cards: { id: string; title: string }[] }>(await api.post(`/api/boards/${targetId}/open`));
  const copy = targetBoard.cards.find((card) => card.title === title)!;
  const privateNote = "Internal: add a regression fixture before merging the export query fix.";
  await json(await api.post(`/api/cards/${copy.id}/comments`, { data: { body: privateNote } }));
  const revised = `${commentBody} The attached CSV has the expected totals.`;
  await json(await api.patch(`/api/comments/${comment.id}`, { data: { body: revised } }));
  await expect(dialog.locator(".comment").filter({ hasText: revised })).toHaveCount(1);
  await expect(dialog.locator(".comment").filter({ hasText: privateNote })).toHaveCount(1);
  const sourceFeed = await json<{ items: { type: string; data: { body?: string } }[] }>(await api.get(`/api/cards/${source.id}/feed?limit=100`));
  expect(sourceFeed.items.some((item) => item.data.body?.includes(privateNote))).toBe(false);
  const detail = await json<{ attachments: { url: string; fileName: string }[] }>(await api.get(`/api/cards/${copy.id}/detail`));
  const copiedFile = detail.attachments.find((file) => file.fileName === fileName)!;
  const downloaded = await api.get(copiedFile.url);
  expect(downloaded.ok()).toBe(true);
  expect(await downloaded.body()).toEqual(bytes);
  await page.screenshot({ path: testInfo.outputPath("live-client-sync.png") });
});
