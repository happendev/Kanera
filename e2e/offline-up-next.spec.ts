import type { APIResponse, Locator } from "@playwright/test";
import { test, expect } from "./support/fixtures";
import { SocketLink } from "./support/socket";

async function result<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

async function readOnly(queue: Locator, title: string) {
  await expect(queue).toContainText(title);
  const rows = queue.locator(".panel-row");
  expect(await rows.count()).toBeGreaterThan(0);
  for (const row of await rows.all()) await expect(row).toHaveClass(/cdk-drag-disabled/);
  await rows.first().dispatchEvent("contextmenu");
  await expect(queue.locator("k-card-actions-menu")).toHaveCount(0);
  await expect(queue.locator(".row-tools")).toHaveCount(0);
  await expect(queue.getByRole("button", { name: /Add card/ })).toHaveCount(0);
}

test("Up next restores the latest saved queue offline without editing, then refreshes on reconnect", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const me = await result<{ id: string; clientId: string; activeClientId?: string }>(await api.get("/api/me"));
  const workspace = await result<{ id: string; initialBoard: { id: string } }>(await api.post("/api/workspaces", {
    data: { name: uniqueName("Offline queue"), initialBoard: { name: uniqueName("Offline queue board") } },
  }));
  const board = await result<{ lists: { id: string }[] }>(await api.get(`/api/boards/${workspace.initialBoard.id}?includeCards=false`));
  const title = uniqueName("Cached next task");
  const updatedTitle = uniqueName("Latest next task");
  const reconnectedTitle = uniqueName("Updated while disconnected");
  const card = await result<{ id: string }>(await api.post(`/api/boards/${workspace.initialBoard.id}/lists/${board.lists[0]!.id}/cards`, {
    data: { title, assigneeIds: [me.id] },
  }));
  await result(await api.post(`/api/work/priorities/${me.id}/cards`, { data: { cardId: card.id, beforeId: null } }));
  const socket = await SocketLink.install(page.context());
  const drawer = page.getByRole("dialog", { name: "Up next", exact: true });
  const cachedKey = `${me.activeClientId ?? me.clientId}:${me.id}`;
  try {
    await signIn(page, "amelia");
    await expect(page.locator("k-home k-priority-queue")).toContainText(title);
    // Warm the route and lazy drawer: the dev server has no production service-worker asset cache.
    await page.locator('aside.sidebar a[href="/my-cards"]').click();
    await expect(page.locator("k-global-work")).toBeVisible();
    await page.getByRole("button", { name: "Board view", exact: true }).click();
    await page.keyboard.press("u");
    await expect(drawer).toContainText(title);
    await result(await api.patch(`/api/cards/${card.id}`, { data: { title: updatedTitle } }));
    await expect(drawer).toContainText(updatedTitle);
    // Require the realtime update to reach IndexedDB before destroying the entire Angular session.
    await expect.poll(() => page.evaluate(async ({ key, cardId }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("kanera-offline");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Could not open offline cache"));
      });
      try {
        return await new Promise<string | null>((resolve) => {
          if (!db.objectStoreNames.contains("priorityQueues")) return resolve(null);
          const request = db.transaction("priorityQueues").objectStore("priorityQueues").get(key);
          request.onsuccess = () => {
            const saved = request.result as { response: { items: { card: { id: string; title: string } | null }[] } } | undefined;
            resolve(saved?.response.items.find((item) => item.card?.id === cardId)?.card?.title ?? null);
          };
        });
      } finally { db.close(); }
    }, { key: cachedKey, cardId: card.id })).toBe(updatedTitle);
    await page.keyboard.press("Escape");
    await socket.cut();
    await expect.poll(() => socket.refusedAttempts).toBeGreaterThan(0);
    // Permit static dev assets for a cold reload while all API and realtime traffic is unavailable.
    await page.route("**/api/**", (route) => route.abort("internetdisconnected"));
    await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false }));
    await page.reload();
    await expect(page.locator("k-app-shell")).toBeVisible();
    await page.getByRole("button", { name: /^Up next/ }).first().click();
    await readOnly(drawer, updatedTitle);
    await expect(drawer).toContainText("Offline copy from");
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: testInfo.outputPath(`offline-up-next-${width}.png`), animations: "disabled" });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    const dockToggle = page.locator("k-global-work .up-next-toggle");
    await expect(dockToggle).toBeEnabled();
    const dock = page.locator("k-up-next-panel");
    if (!await dock.isVisible()) await dockToggle.click();
    await readOnly(dock, updatedTitle);
    await expect(dock).toContainText("Offline copy from");
    await page.screenshot({ path: testInfo.outputPath("offline-up-next-my-cards.png"), animations: "disabled" });
    await dock.getByRole("button", { name: "Close Up next", exact: true }).click();
    await page.locator('aside.sidebar a.nav-item[href="/"]').click();
    await readOnly(page.locator("k-home k-priority-queue"), updatedTitle);
    // Server changes made during the outage replace the snapshot when connectivity returns.
    await result(await api.patch(`/api/cards/${card.id}`, { data: { title: reconnectedTitle } }));
    await page.unroute("**/api/**");
    socket.restore();
    await page.evaluate(() => {
      Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
      window.dispatchEvent(new Event("online"));
    });
    await page.keyboard.press("u");
    await expect(drawer).toContainText(reconnectedTitle);
    await expect(drawer.locator(".panel-row").filter({ hasText: reconnectedTitle })).not.toHaveClass(/cdk-drag-disabled/);
    await expect(drawer).not.toContainText("Offline copy from");
  } finally {
    socket.restore();
    await page.unroute("**/api/**");
    await api.delete(`/api/workspaces/${workspace.id}`);
  }
});
