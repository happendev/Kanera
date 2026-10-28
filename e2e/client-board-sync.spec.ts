import type { APIResponse } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { openCard, cardTile, expectBoardLoaded } from "./support/ui";

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as T;
}

// Use owned fixtures for live writes: a broken copy loop, stale source edits or a lost internal
// note must be caught using this test's own boards and workspace.
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
  const source = await json<{ id: string }>(await api.post(`/api/boards/${testWorkspace.boardId}/lists/${listId}/cards`, { data: { title, dueDateLocalDate: "2030-04-03", dueDateTimezone: "UTC" } }));
  await expect(cardTile(page, title)).toHaveCount(1);
  const dialog = await openCard(page, title);
  const targetBoard = await json<{ cards: { id: string; title: string }[] }>(await api.post(`/api/boards/${targetId}/open`));
  const copy = targetBoard.cards.find((card) => card.title === title)!;
  const privateNote = "Internal: add a regression fixture before merging the export query fix.";
  const privateComment = await json<{ createdAt: string }>(await api.post(`/api/cards/${copy.id}/comments`, { data: { body: privateNote } }));
  const priya = await apiAs("priya");
  const owner = await json<{ id: string }>(await priya.get("/api/me"));
  await json(await api.put(`/api/cards/${copy.id}/assignees`, { data: { userIds: [owner.id] } }));
  await json(await api.patch(`/api/cards/${copy.id}`, { data: { dueDateLocalDate: "2030-04-05", dueDateSlot: null, dueDateTimezone: "UTC" } }));
  const field = await json<{ id: string }>(await api.post(`/api/workspaces/${testWorkspace.id}/custom-fields`, {
    data: { name: uniqueName("Implementation branch"), type: "text" },
  }));
  await json(await api.put(`/api/cards/${copy.id}/custom-fields/${field.id}`, { data: { valueText: "fix/northstar-invoice-export" } }));
  const commentBody = "Finance confirms the tax column is duplicated too. Please check the revised example.";
  const comment = await json<{ id: string; createdAt: string }>(await api.post(`/api/cards/${source.id}/comments`, { data: { body: commentBody } }));
  await expect(dialog.locator(".comment").filter({ hasText: commentBody })).toHaveCount(1);
  const fileName = "northstar-revised-export.csv";
  const bytes = Buffer.from("invoice_number,net,tax,gross\nNS-1048,1200.00,240.00,1440.00\n");
  const upload = await json<{ createdAt: string }>(await api.post(`/api/cards/${source.id}/attachments`, {
    multipart: { file: { name: fileName, mimeType: "text/csv", buffer: bytes } },
  }));
  await expect(dialog.locator("li.attach-row").filter({ hasText: fileName })).toHaveCount(1);
  expect(Date.parse(privateComment.createdAt)).toBeLessThan(Date.parse(comment.createdAt));
  expect(Date.parse(privateComment.createdAt)).toBeLessThan(Date.parse(upload.createdAt));
  // Exercise a managed core facet as well: it must refresh the description without resetting
  // the destination's independent owner, delivery date, private fields or conversation.
  await json(await api.patch(`/api/cards/${source.id}`, { data: { description: "The revised reproduction includes the duplicated tax column." } }));
  const revised = `${commentBody} The attached CSV has the expected totals.`;
  await json(await api.patch(`/api/comments/${comment.id}`, { data: { body: revised } }));
  await expect(dialog.locator(".comment").filter({ hasText: revised })).toHaveCount(1);
  await expect(dialog.locator(".comment").filter({ hasText: privateNote })).toHaveCount(1);
  const sourceFeed = await json<{ items: { type: string; data: { body?: string } }[] }>(await api.get(`/api/cards/${source.id}/feed?limit=100`));
  expect(sourceFeed.items.some((item) => item.data.body?.includes(privateNote))).toBe(false);
  const detail = await json<{ card: { description: string; dueDateLocalDate: string }; assigneeIds: string[];
    customFieldValues: { fieldId: string; valueText: string | null }[]; attachments: { url: string; fileName: string }[] }>(await api.get(`/api/cards/${copy.id}/detail`));
  await expect.poll(async () => (await json<typeof detail>(await api.get(`/api/cards/${copy.id}/detail`))).card.description)
    .toBe("The revised reproduction includes the duplicated tax column.");
  const settled = await json<typeof detail>(await api.get(`/api/cards/${copy.id}/detail`));
  expect(settled.assigneeIds).toEqual([owner.id]);
  expect(settled.card.dueDateLocalDate).toBe("2030-04-05");
  expect(settled.customFieldValues).toContainEqual(expect.objectContaining({ fieldId: field.id, valueText: "fix/northstar-invoice-export" }));
  const sourceDetail = await json<typeof detail>(await api.get(`/api/cards/${source.id}/detail`));
  expect(sourceDetail.assigneeIds).not.toContain(owner.id);
  expect(sourceDetail.card.dueDateLocalDate).toBe("2030-04-03");
  expect(sourceDetail.customFieldValues.some((value) => value.fieldId === field.id)).toBe(false);
  const copiedFile = detail.attachments.find((file) => file.fileName === fileName)!;
  const downloaded = await api.get(copiedFile.url);
  expect(downloaded.ok()).toBe(true);
  expect(await downloaded.body()).toEqual(bytes);
  await page.screenshot({ path: testInfo.outputPath("live-client-sync.png") });
});
