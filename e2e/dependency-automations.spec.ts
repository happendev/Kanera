import { randomUUID } from "node:crypto";
import type { APIResponse } from "@playwright/test";
import ports from "./ports.json";
import { expect, test } from "./support/fixtures";
import { boardIdOf, expectBoardLoaded, expectCardTileMounted, openBoard, openCard, workspaceSettingsHref } from "./support/ui";

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

// Real MCP -> public API -> outbox -> app API/worker -> browser. These checks catch a trigger
// omitted from MCP schemas, repeated actions while already blocked, and missing cross-board fanout.
test("MCP blocked and unblocked automations follow dependency boundaries live", async ({ page, signIn, apiAs, playwright, uniqueName }) => {
  await signIn(page, "amelia");
  const api = await apiAs("amelia");
  const boardId = await boardIdOf(page, "Platform Delivery");
  const blockerBoardId = await boardIdOf(page, "Mobile Experience");
  const settingsHref = await workspaceSettingsHref(page, "Platform Delivery");
  const meta = await (await api.get(`/api/boards/${boardId}?includeCards=false`)).json() as { board: { workspaceId: string }; lists: { id: string }[] };
  const workspaceId = meta.board.workspaceId;
  const listId = meta.lists[0]!.id;
  const response = await api.post(`/api/workspaces/${workspaceId}/api-keys`, { data: { name: uniqueName("Dep key").slice(0, 25), scope: "admin" } });
  expect(response.status(), await response.text()).toBe(201);
  const key = await response.json() as { id: string; secret: string };
  const client = await playwright.request.newContext({ extraHTTPHeaders: { authorization: `Bearer ${key.secret}`, "MCP-Protocol-Version": "2026-07-28" } });
  const tool = async <T = unknown>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = await client.post(`http://localhost:${ports.mcp}/mcp`, {
      headers: { "Mcp-Method": "tools/call", "Mcp-Name": name },
      data: { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } },
    });
    expect(result.ok(), await result.text()).toBe(true);
    const body = await result.json() as { error?: unknown; result: { isError?: boolean; structuredContent: T } };
    expect(body.error).toBeUndefined();
    expect(body.result.isError, JSON.stringify(body.result)).not.toBe(true);
    return body.result.structuredContent;
  };
  const cardIds: string[] = [];
  const ruleIds: string[] = [];
  try {
    const title = uniqueName("Dependency automation waiting");
    const create = async (board: string, title: string) => {
      const card = await tool<{ id: string }>("cards.create", { boardId: board, listId, title, idempotencyKey: randomUUID() });
      cardIds.push(card.id);
      return card.id;
    };
    const waiting = await create(boardId, title);
    const first = await create(blockerBoardId, uniqueName("First blocker"));
    const second = await create(blockerBoardId, uniqueName("Second blocker"));
    const blockedText = uniqueName("Automation blocked");
    const readyText = uniqueName("Automation ready");
    for (const [triggerType, template] of [["card_blocked", blockedText], ["card_unblocked", readyText]]) {
      const rule = await tool<{ id: string }>("automations.create", { workspaceId, enabled: true, triggerType, actions: [{ type: "post_comment", config: { template } }] });
      ruleIds.push(rule.id);
    }

    // See the new trigger and both help messages on desktop and phone.
    await page.goto(`${settingsHref}/automations`);
    // Other specs create dependency rules in this workspace too; pick ours by id, not by trigger label.
    const blockedRule = page.locator(`.automation-card[data-automation-id="${ruleIds[0]}"]`);
    await blockedRule.locator(".ac-identity").click();
    await expect(blockedRule.locator(".ac-trigger-note")).toContainText("first active blocker");
    for (const [label, width] of [["desktop", 1280], ["phone", 390]] as const) {
      await page.setViewportSize({ width, height: 900 });
      await blockedRule.scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath(`blocked-automation-${label}.png`), animations: "disabled" });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    const readyRule = page.locator(`.automation-card[data-automation-id="${ruleIds[1]}"]`);
    await readyRule.locator(".ac-identity").click();
    await expect(readyRule.locator(".ac-trigger-note")).toContainText("integrations and automations");
    await openBoard(page, "Platform Delivery");
    await expectCardTileMounted(page, title);
    const detail = await openCard(page, title);
    await detail.getByRole("button", { name: "Activity", exact: false }).click();
    const counts = async (blocked: number, ready: number) => {
      await expect(detail.getByText(blockedText, { exact: true })).toHaveCount(blocked);
      await expect(detail.getByText(readyText, { exact: true })).toHaveCount(ready);
    };
    const relation = (otherCardIds: string[], remove = false) => tool("cards.set_relations", { cardId: waiting, direction: "blocked_by", otherCardIds, remove });
    await counts(0, 0);
    await relation([first]);
    await counts(1, 0);
    await relation([first, second]);
    await tool("cards.set_completion", { cardId: first, completed: true });
    await counts(1, 0);
    await tool("cards.set_completion", { cardId: second, completed: true });
    await counts(1, 1);
    await tool("cards.set_completion", { cardId: second, completed: true });
    await counts(1, 1);
    await tool("cards.set_completion", { cardId: first, completed: false });
    await counts(2, 1);
    await tool("cards.archive", { cardId: first, archived: true });
    await counts(2, 2);
    await tool("cards.archive", { cardId: first, archived: false });
    await counts(3, 2);
    await relation([first], true);
    await counts(3, 3);
    // A list-entry automation reopens the remaining blocker; dependency automations must chain.
    const reopenListId = meta.lists[1]!.id;
    const reopenRule = await tool<{ id: string }>("automations.create", { workspaceId, enabled: true, triggerType: "card_enters_list", triggerListId: reopenListId, applyOnCreate: false, applyOnMove: true, actions: [{ type: "set_completion", config: { completed: false } }] });
    ruleIds.push(reopenRule.id);
    await tool("cards.move", { cardId: second, listId: reopenListId, anchor: { side: "before", id: null } });
    await counts(4, 3);
    await tool("cards.set_completion", { cardId: second, completed: true });
    await counts(4, 4);
    await page.screenshot({ path: test.info().outputPath("dependency-automation-live-comments.png"), animations: "disabled" });
  } finally {
    for (const id of ruleIds) expect((await api.delete(`/api/automations/${id}`)).ok()).toBe(true);
    for (const id of cardIds) expect((await api.patch(`/api/cards/${id}/archive`, { data: { archived: true } })).ok()).toBe(true);
    await api.delete(`/api/workspaces/${workspaceId}/api-keys/${key.id}`);
    await client.dispose();
  }
});

// A mirror has a durable creator but no human trigger actor. That distinction must survive the
// automation chain, or its creator misses a downstream handoff as though they performed it.
test("a mirror's creator receives downstream automation handoffs live", async ({ page, signIn, apiAs, uniqueName }) => {
  const api = await apiAs("amelia");
  const editor = await apiAs("marcus");
  const workspaceName = uniqueName("Mirror dependency handoff");
  const workspace = await json<{ id: string; initialBoard: { id: string } }>(await api.post("/api/workspaces", {
    data: { name: workspaceName, initialBoard: { name: uniqueName("Mirror source") }, listNames: ["Queue", "Done"], customFields: [] },
  }));
  try {
    await json(await api.patch(`/api/workspaces/${workspace.id}`, { data: { boardLinkingEnabled: true } }));
    const targetName = uniqueName("Mirror handoff destination");
    const target = await json<{ id: string }>(await api.post(`/api/workspaces/${workspace.id}/boards`, { data: { name: targetName } }));
    const sourceId = workspace.initialBoard.id;
    const meta = await json<{ lists: { id: string }[] }>(await api.get(`/api/boards/${sourceId}?includeCards=false`));
    const listId = meta.lists[0]!.id;
    await json(await api.post(`/api/boards/${sourceId}/mirrors`, { data: { targetBoardId: target.id, lists: [{ sourceListId: listId }] } }));
    const create = (boardId: string, title: string) => api.post(`/api/boards/${boardId}/lists/${listId}/cards`, { data: { title } }).then(json<{ id: string; key: string }>);
    const sourceTitle = uniqueName("Mirrored prerequisite");
    const source = await create(sourceId, sourceTitle);
    const targetCards = () => api.post(`/api/boards/${target.id}/open?includeCompleted=true`).then(json<{ cards: { id: string; title: string; completedAt: string | null }[] }>);
    await expect.poll(async () => (await targetCards()).cards.some((card) => card.title === sourceTitle)).toBe(true);
    const copy = (await targetCards()).cards.find((card) => card.title === sourceTitle)!;
    const middle = await create(target.id, uniqueName("Automatically completed middle"));
    const waitingTitle = uniqueName("Creator's downstream work");
    const waiting = await create(target.id, waitingTitle);
    const me = await json<{ id?: string; user?: { id: string } }>(await api.get("/api/me"));
    await json(await api.put(`/api/cards/${waiting.id}/assignees`, { data: { userIds: [me.user?.id ?? me.id!] } }));
    for (const [dependentId, blockerId] of [[middle.id, copy.id], [waiting.id, middle.id]]) {
      await json(await api.post(`/api/cards/${dependentId}/relations`, { data: { targetCardId: blockerId, direction: "blocked_by" } }));
    }
    // Observe the first mirrored completion before installing the rule. The next reopening blocks
    // the middle card, whose automation completes it and hands the final card to the creator.
    await json(await editor.patch(`/api/cards/${source.id}/completion`, { data: { completed: true } }));
    await expect.poll(async () => (await targetCards()).cards.find((card) => card.id === copy.id)?.completedAt).toBeTruthy();
    await json(await api.post(`/api/workspaces/${workspace.id}/automations`, {
      data: { enabled: true, triggerType: "card_blocked", actions: [{ type: "set_completion", config: { completed: true } }] },
    }));
    await signIn(page, "amelia");
    await page.goto(`/b/${target.id}`);
    await expectBoardLoaded(page, targetName);
    await page.getByRole("button", { name: /^Notifications/ }).click();
    const handoff = page.locator(".notif-item").filter({ hasText: waitingTitle }).filter({ hasText: "cleared the last blocker on this card" });
    await expect(handoff).toHaveCount(0);
    await json(await editor.patch(`/api/cards/${source.id}/completion`, { data: { completed: false } }));
    await expect(handoff).toHaveCount(1);
    await expect(handoff).toBeVisible();
    await expect(handoff.locator(".actor-name")).toHaveText("Kanera");
    await expect(handoff).toContainText(middle.key);
    await page.screenshot({ path: test.info().outputPath("mirror-downstream-handoff.png"), animations: "disabled" });
  } finally {
    expect((await api.delete(`/api/workspaces/${workspace.id}`, { data: { confirmationName: workspaceName } })).ok()).toBe(true);
  }
});
