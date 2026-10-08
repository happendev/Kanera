import type { APIResponse } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { cardTile, expectBoardLoaded, openCard } from "./support/ui";

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

test("idle board mirrors wake, publish live updates and reconcile a paused interval", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const sourceName = uniqueName("Async source");
  const targetName = uniqueName("Async destination");
  const workspace = await json<{ id: string; initialBoard: { id: string } }>(await api.post("/api/workspaces", {
    data: { name: sourceName, initialBoard: { name: sourceName }, listNames: ["Queue", "Done"], customFields: [] },
  }));
  await json(await api.patch(`/api/workspaces/${workspace.id}`, { data: { boardLinkingEnabled: true } }));
  const sourceId = workspace.initialBoard.id;
  const target = await json<{ id: string }>(await api.post(`/api/workspaces/${workspace.id}/boards`, { data: { name: targetName } }));
  const witness = await json<{ id: string }>(await api.post(`/api/workspaces/${workspace.id}/boards`, { data: { name: uniqueName("Worker witness") } }));
  const board = await json<{ lists: { id: string }[] }>(await api.get(`/api/boards/${sourceId}?includeCards=false`));
  const create = (title: string) => api.post(`/api/boards/${sourceId}/lists/${board.lists[0]!.id}/cards`, { data: { title } }).then(json<{ id: string }>);
  const oldTitle = uniqueName("Existing before mirror");
  await create(oldTitle);
  const mirror = await json<{ id: string; lastSyncAt: string }>(await api.post(`/api/boards/${sourceId}/mirrors`, {
    data: { targetBoardId: target.id, lists: [{ sourceListId: board.lists[0]!.id }] },
  }));
  await json(await api.post(`/api/boards/${sourceId}/mirrors`, {
    data: { targetBoardId: witness.id, lists: [{ sourceListId: board.lists[0]!.id }] },
  }));
  const mirrorRows = () => api.get(`/api/boards/${target.id}/mirrors`).then(json<Array<{ id: string; lastSyncAt: string | null; reconcileRequestedAt: string | null; lastError: string | null }>>);
  await signIn(page, "amelia");
  await page.goto(`/b/${target.id}`);
  await expectBoardLoaded(page, targetName);
  // Observe a worker checkpoint before introducing new work. A fixed sleep cannot prove the
  // worker ran on a loaded CI host. Empty-poll write counts are covered by drain.itest.ts.
  await expect.poll(async () => Date.parse((await mirrorRows()).find((row) => row.id === mirror.id)?.lastSyncAt ?? "")).toBeGreaterThan(Date.parse(mirror.lastSyncAt));
  await expect(cardTile(page, oldTitle)).toHaveCount(0);
  const idle = (await mirrorRows()).find((row) => row.id === mirror.id)!;

  const title = uniqueName("Created after idle");
  const sourceCard = await create(title);
  await expect(cardTile(page, title)).toHaveCount(1);
  const renamed = uniqueName("Live mirror rename");
  await json(await api.patch(`/api/cards/${sourceCard.id}`, { data: { title: renamed } }));
  await expect(cardTile(page, renamed)).toHaveCount(1);
  const detail = await openCard(page, renamed);
  const comment = uniqueName("Live mirrored discussion");
  await json(await api.post(`/api/cards/${sourceCard.id}/comments`, { data: { body: comment } }));
  await expect(detail.locator(".comment").filter({ hasText: comment })).toHaveCount(1);
  await page.keyboard.press("Escape");

  await json(await api.patch(`/api/boards/${target.id}/mirrors/${mirror.id}`, { data: { paused: true } }));
  const pausedTitle = uniqueName("Updated during pause");
  await json(await api.patch(`/api/cards/${sourceCard.id}`, { data: { title: pausedTitle } }));
  const createdDuringPause = uniqueName("Created during pause");
  await create(createdDuringPause);
  // The unpaused witness proves the real worker processed this source event before we assert
  // the paused destination stayed unchanged; elapsed time alone would allow a stalled worker
  // to make the negative assertion pass. This query also verifies persisted convergence.
  await expect.poll(async () => {
    const snapshot = await json<{ cards: { title: string }[] }>(await api.post(`/api/boards/${witness.id}/open`));
    return snapshot.cards.map((card) => card.title);
  }).toContain(createdDuringPause);
  const pausedSnapshot = await json<{ cards: { title: string }[] }>(await api.post(`/api/boards/${target.id}/open`));
  expect(pausedSnapshot.cards.map((card) => card.title)).toEqual([renamed]);
  await expect(cardTile(page, renamed)).toHaveCount(1);
  await expect(cardTile(page, pausedTitle)).toHaveCount(0);
  await expect(cardTile(page, createdDuringPause)).toHaveCount(0);

  // Resume resets the event cursor past the paused card events and requests reconciliation.
  // The remaining mirror metadata events carry no card facets, so replay alone cannot recover
  // the rename/new card: the optimized worker must still honor the reconciliation request.
  await json(await api.patch(`/api/boards/${target.id}/mirrors/${mirror.id}`, { data: { paused: false } }));
  await expect(cardTile(page, pausedTitle)).toHaveCount(1);
  await expect(cardTile(page, createdDuringPause)).toHaveCount(1);
  await expect(cardTile(page, oldTitle)).toHaveCount(0);
  await expect.poll(async () => (await mirrorRows()).find((row) => row.id === mirror.id)?.reconcileRequestedAt).toBeNull();
  const resumed = (await mirrorRows()).find((row) => row.id === mirror.id)!;
  expect(resumed.lastError).toBeNull();
  await page.reload();
  await expectBoardLoaded(page, targetName);
  await expect(cardTile(page, pausedTitle)).toHaveCount(1);
  await expect(cardTile(page, createdDuringPause)).toHaveCount(1);
  await expect(cardTile(page, oldTitle)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("async-mirror-reconciled.png") });
  await testInfo.attach("async-mirror-evidence.json", {
    body: JSON.stringify({ reproduce: "pnpm test:e2e -- performance-async.spec.ts", workspaceId: workspace.id, sourceId, targetId: target.id, witnessId: witness.id, mirrorId: mirror.id, sourceCardId: sourceCard.id, idle, pausedSnapshot, resumed }, null, 2),
    contentType: "application/json",
  });
});
