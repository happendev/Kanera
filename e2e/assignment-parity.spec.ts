import type { APIRequestContext, APIResponse } from "@playwright/test";
import { webOrigin } from "./support/env";
import { expect, test } from "./support/fixtures";
import { cardTile, expectBoardLoaded } from "./support/ui";

async function result<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

type AssignmentEvent = { cardId: string; labelIds?: string[]; assigneeIds?: string[] };

test("single and bulk assignments preserve automation results and reach open boards and inboxes", async ({ page, signIn, pageAs, apiAs, playwright, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const teammateApi = await apiAs("marcus");
  const owner = await result<{ id: string }>(await api.get("/api/me"));
  const teammate = await result<{ id: string }>(await teammateApi.get("/api/me"));
  const workspaceName = uniqueName("Assignment parity");
  const workspace = await result<{ id: string }>(await api.post("/api/workspaces", {
    data: { name: workspaceName, listNames: ["To do", "Done"], customFields: [] },
  }));
  let keyId: string | undefined;
  let publicApi: APIRequestContext | undefined;
  const received: Array<{ type: string; event: AssignmentEvent }> = [];
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
    const frame = payload.toString();
    if (!/^42\["card:(labels|assignees):set",/.test(frame)) return;
    const [type, event] = JSON.parse(frame.slice(2)) as [string, AssignmentEvent];
    received.push({ type, event });
  }));
  try {
    await result(await api.post(`/api/workspaces/${workspace.id}/members`, { data: { userId: teammate.id, role: "member" } }));
    const boardName = uniqueName("Assignment board");
    const board = await result<{ id: string }>(await api.post(`/api/workspaces/${workspace.id}/boards`, { data: { name: boardName } }));
    const configuration = await result<{ lists: Array<{ id: string }> }>(await api.get(`/api/workspaces/${workspace.id}`));
    const triggerLabel = await result<{ id: string; name: string }>(await api.post(`/api/workspaces/${workspace.id}/card-labels`, { data: { name: "Requested", color: "blue" } }));
    const automaticLabel = await result<{ id: string; name: string }>(await api.post(`/api/workspaces/${workspace.id}/card-labels`, { data: { name: "Automated", color: "green" } }));
    await result(await api.post(`/api/workspaces/${workspace.id}/automations`, { data: {
      enabled: true, triggerType: "card_label_set", triggerLabelId: triggerLabel.id,
      actions: [{ type: "add_labels", config: { labelIds: [automaticLabel.id] } }],
    } }));
    await result(await api.post(`/api/workspaces/${workspace.id}/automations`, { data: {
      enabled: true, triggerType: "card_assigned_to_user", triggerUserIds: [teammate.id],
      actions: [{ type: "add_assignees", config: { userIds: [owner.id] } }],
    } }));
    const cards: Array<{ id: string; title: string }> = [];
    for (const kind of ["Single", "Bulk"]) {
      cards.push(await result(await api.post(`/api/boards/${board.id}/lists/${configuration.lists[0]!.id}/cards`, {
        data: { title: uniqueName(`${kind} assignment`), assigneeIds: [] },
      })));
    }
    const key = await result<{ id: string; secret: string }>(await api.post("/api/me/api-keys", { data: { label: uniqueName("Assignment key"), scope: "write" } }));
    keyId = key.id;
    publicApi = await playwright.request.newContext({ baseURL: webOrigin, extraHTTPHeaders: { authorization: `Bearer ${key.secret}` } });
    await signIn(page, "amelia");
    await page.goto(`/b/${board.id}`);
    await expectBoardLoaded(page, boardName);
    for (const card of cards) await expect(cardTile(page, card.title)).toBeVisible();
    const inbox = await pageAs("marcus");
    await inbox.getByRole("button", { name: /^Notifications/ }).click();
    await inbox.getByRole("group", { name: "Read state" }).getByRole("button", { name: "All", exact: true }).click();
    const base = "/public-api/api/v1";
    for (const [index, card] of cards.entries()) {
      const bulk = index === 1;
      if (bulk) {
        expect(await result(await publicApi.patch(`${base}/boards/${board.id}/cards/bulk/labels`, {
          data: { cardIds: [card.id], mode: "add", labelIds: [triggerLabel.id] },
        }))).toMatchObject({ updated: 1, updatedCardIds: [card.id] });
        expect(await result(await publicApi.patch(`${base}/boards/${board.id}/cards/bulk/assignees`, {
          data: { cardIds: [card.id], mode: "add", userIds: [teammate.id] },
        }))).toMatchObject({ updated: 1, updatedCardIds: [card.id] });
      } else {
        const labels = await result<{ labelIds: string[] }>(await publicApi.put(`${base}/cards/${card.id}/labels`, { data: { labelIds: [triggerLabel.id] } }));
        expect(labels.labelIds.sort()).toEqual([triggerLabel.id, automaticLabel.id].sort());
        const assignees = await result<{ assigneeIds: string[] }>(await publicApi.put(`${base}/cards/${card.id}/assignees`, { data: { userIds: [teammate.id] } }));
        expect(assignees.assigneeIds.sort()).toEqual([teammate.id, owner.id].sort());
      }
      const tile = cardTile(page, card.title);
      await expect(tile.locator(".label-chip-text")).toHaveText([triggerLabel.name, automaticLabel.name]);
      await expect(tile.locator(".assignee-avatar")).toHaveCount(2);
      await expect(inbox.locator(".notif-item").filter({ hasText: card.title }).first()).toBeVisible();
      const persisted = await result<{ labelIds: string[]; assigneeIds: string[] }>(await api.get(`/api/cards/${card.id}/detail`));
      expect(persisted.labelIds.sort()).toEqual([triggerLabel.id, automaticLabel.id].sort());
      expect(persisted.assigneeIds.sort()).toEqual([teammate.id, owner.id].sort());
      const labels = received.filter((entry) => entry.type === "card:labels:set" && entry.event.cardId === card.id);
      expect(labels[0]?.event.labelIds).toEqual([triggerLabel.id]);
      expect(labels.at(-1)?.event.labelIds?.slice().sort()).toEqual([triggerLabel.id, automaticLabel.id].sort());
      const assignees = received.filter((entry) => entry.type === "card:assignees:set" && entry.event.cardId === card.id);
      expect(assignees[0]?.event.assigneeIds?.slice().sort()).toEqual((bulk ? [teammate.id] : [teammate.id, owner.id]).sort());
      expect(assignees.at(-1)?.event.assigneeIds?.slice().sort()).toEqual([teammate.id, owner.id].sort());
    }
    await page.screenshot({ path: testInfo.outputPath("assignments-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("assignments-phone.png"), fullPage: true, animations: "disabled" });
    await inbox.setViewportSize({ width: 390, height: 844 });
    await expect(inbox.locator(".notif-item").filter({ hasText: cards[1]!.title }).first()).toBeVisible();
    await inbox.screenshot({ path: testInfo.outputPath("assignment-inbox-phone.png"), fullPage: true, animations: "disabled" });
    const bulkCard = cards[1]!;
    for (const [kind, ids] of [["labels", { labelIds: [triggerLabel.id] }], ["assignees", { userIds: [teammate.id] }]] as const) {
      expect(await result(await publicApi.patch(`${base}/boards/${board.id}/cards/bulk/${kind}`, {
        data: { cardIds: [bulkCard.id], mode: "add", ...ids },
      }))).toMatchObject({ updated: 0, updatedCardIds: [] });
    }
    for (const [index, card] of cards.entries()) {
      if (index === 0) {
        await result(await publicApi.put(`${base}/cards/${card.id}/labels`, { data: { labelIds: [] } }));
        await result(await publicApi.put(`${base}/cards/${card.id}/assignees`, { data: { userIds: [] } }));
      } else {
        await result(await publicApi.patch(`${base}/boards/${board.id}/cards/bulk/labels`, { data: { cardIds: [card.id], mode: "remove", labelIds: [triggerLabel.id, automaticLabel.id] } }));
        await result(await publicApi.patch(`${base}/boards/${board.id}/cards/bulk/assignees`, { data: { cardIds: [card.id], mode: "remove", userIds: [teammate.id, owner.id] } }));
      }
      await expect(cardTile(page, card.title).locator(".label-chip")).toHaveCount(0);
      await expect(cardTile(page, card.title).locator(".assignee-avatar")).toHaveCount(0);
    }
    await testInfo.attach("assignment-events.json", { body: JSON.stringify(received, null, 2), contentType: "application/json" });
  } finally {
    await publicApi?.dispose();
    if (keyId) expect((await api.delete(`/api/me/api-keys/${keyId}`)).ok()).toBe(true);
    expect((await api.delete(`/api/workspaces/${workspace.id}`, { data: { confirmationName: workspaceName } })).ok()).toBe(true);
  }
});
