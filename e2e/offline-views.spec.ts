import type { APIResponse } from "@playwright/test";
import { test, expect } from "./support/fixtures";
import { SocketLink } from "./support/socket";

async function result<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

for (const scope of ["board", "my-cards", "team-cards"] as const) {
  test(`${scope} restores Timeline, Dependencies and Work done after a cold offline reload`, async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
    const api = await apiAs("amelia");
    const author = scope === "team-cards" ? await apiAs("priya") : api;
    const person = await result<{ id: string }>(await author.get("/api/me"));
    const workspace = await result<{ id: string; initialBoard: { id: string } }>(await api.post("/api/workspaces", {
      data: { name: uniqueName("Offline views"), initialBoard: { name: uniqueName("Cached views") } },
    }));
    const socket = await SocketLink.install(page.context());
    try {
      if (scope === "team-cards") await result(await api.post(`/api/workspaces/${workspace.id}/members`, { data: { userId: person.id, role: "admin" } }));
      const board = await result<{ lists: { id: string }[] }>(await api.get(`/api/boards/${workspace.initialBoard.id}?includeCards=false`));
      const title = uniqueName(`Offline ${scope} plan`);
      const start = new Date();
      start.setUTCDate(start.getUTCDate() + 1);
      while (start.getUTCDay() !== 1) start.setUTCDate(start.getUTCDate() + 1);
      const due = new Date(start);
      due.setUTCDate(due.getUTCDate() + 2);
      const cards: { id: string; key: string; title: string }[] = [];
      for (const suffix of ["first", "second"]) {
        cards.push(await result(await author.post(`/api/boards/${workspace.initialBoard.id}/lists/${board.lists[0]!.id}/cards`, {
          data: { title: `${title} ${suffix}`, assigneeIds: [person.id], startDateLocalDate: start.toISOString().slice(0, 10), dueDateLocalDate: due.toISOString().slice(0, 10) },
        })));
      }
      const [blocker, dependent] = cards as [typeof cards[number], typeof cards[number]];
      await result(await author.post(`/api/cards/${dependent.id}/relations`, { data: { targetCardId: blocker.id, direction: "blocked_by" } }));
      await signIn(page, "amelia");
      await page.goto(scope === "board" ? `/b/${workspace.initialBoard.id}` : `/${scope}`);
      if (scope !== "board") await page.getByRole("searchbox", { name: "Search cards", exact: true }).fill(title);
      const timeline = page.locator("k-board-timeline-view");
      const map = page.locator("k-dependency-map");
      const history = page.locator("k-work-done-view");
      const bar = timeline.locator(`.tl-row-card[data-card-id="${dependent.id}"] .tl-bar`);
      const wire = timeline.locator(`.tl-wire-hit[aria-label="${dependent.key} waits on ${blocker.key}"]`);
      const select = async (name: string) => { await page.getByRole("button", { name, exact: true }).click(); };
      await select("Timeline view");
      await expect(bar).toBeVisible();
      await expect(wire).toHaveCount(1);
      await expect(bar).toHaveClass(/has-conflict/);
      await select("Critical path");
      await expect(bar).toHaveClass(/is-critical/);
      await select("Dependencies view");
      await expect(map).toContainText(dependent.title);
      await expect(map.locator(".dm-link-handle").first()).toBeAttached();
      await select("Work done");
      await expect(history.locator(".wd-card-title").filter({ hasText: dependent.title })).toBeVisible();
      await page.getByRole("group", { name: "Work done layout", exact: true }).getByRole("button", { name: "Report", exact: true }).click();
      await expect(history.locator(".rp-headline")).toBeVisible();
      const comparison = history.locator(".rp-sentence").filter({ hasText: "previous" });
      await expect(comparison).toBeVisible();
      const reportHeadline = await history.locator(".rp-sentence").first().innerText();
      const reportComparison = await comparison.innerText();
      await page.getByRole("group", { name: "Work done layout", exact: true }).getByRole("button", { name: "List", exact: true }).click();
      await expect(history.locator(".wd-card-title").filter({ hasText: dependent.title })).toBeVisible();
      // The map's existing cache writes in the background; wait for that snapshot too.
      await expect.poll(() => page.evaluate(async (needle) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("kanera-offline");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error("Could not open offline cache"));
        });
        try {
          return await new Promise<boolean>((resolve) => {
            const request = db.transaction("dependencyGraphs").objectStore("dependencyGraphs").getAll();
            request.onsuccess = () => resolve(JSON.stringify(request.result).includes(needle));
          });
        } finally { db.close(); }
      }, dependent.title)).toBe(true);
      await select("Dependencies view");
      const connector = map.locator(`.dm-wire-hit[aria-label="${blocker.key} blocks ${dependent.key}"]`);
      await connector.focus();
      await page.keyboard.press("Enter");
      await map.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(connector).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+z");
      await expect(connector).toHaveCount(1);
      await expect(page.getByRole("status").filter({ hasText: `${dependent.key} now waits on ${blocker.key}` })).toBeVisible();
      const offlineWrites: string[] = [];
      await socket.cut();
      await expect.poll(() => socket.refusedAttempts).toBeGreaterThan(0);
      await page.route("**/api/**", (route) => route.abort("internetdisconnected"));
      page.on("request", (request) => {
        if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) && /\/api\/cards\/[^/]+(?:\/relations|$)/.test(request.url())) offlineWrites.push(request.url());
      });
      await page.evaluate(() => window.dispatchEvent(new Event("offline")));
      await expect(map.locator(".dm-link-handle")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Redo", exact: true })).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+Shift+z");
      await expect(connector).toHaveCount(0);
      await expect(map.locator(".dm-wire")).toHaveCount(1);
      await select("Timeline view");
      await expect(timeline.locator(".tl-handle, .tl-link-handle")).toHaveCount(0);
      await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false }));
      await page.reload();
      await expect(timeline).toContainText("Offline copy from");
      await expect(bar).toBeVisible();
      await expect(wire).toHaveCount(1);
      await expect(bar).toHaveClass(/has-conflict/);
      await expect(bar).toHaveClass(/is-critical/);
      await expect(timeline.locator(".tl-handle, .tl-link-handle")).toHaveCount(0);
      await bar.dispatchEvent("contextmenu");
      await expect(timeline.locator("k-card-actions-menu")).toHaveCount(0);
      await wire.dispatchEvent("click");
      await expect(timeline.locator(".tl-wire-remove")).toHaveCount(0);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await timeline.locator(".tl-zoom button").filter({ has: page.locator(".ti-arrows-horizontal") }).click();
        await expect(bar).toBeInViewport();
        await page.screenshot({ path: testInfo.outputPath(`offline-timeline-${width}.png`), animations: "disabled" });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await select("Dependencies view");
      await expect(map).toContainText("Offline copy from");
      await expect(map).toContainText(dependent.title);
      await expect(map.locator(".dm-link-handle")).toHaveCount(0);
      await page.keyboard.press("Control+z");
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.screenshot({ path: testInfo.outputPath(`offline-dependencies-${width}.png`), animations: "disabled" });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await select("Work done");
      await expect(history).toContainText("Offline copy from");
      await expect(history.locator(".wd-card-title").filter({ hasText: dependent.title })).toBeVisible();
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.screenshot({ path: testInfo.outputPath(`offline-work-done-${width}.png`), animations: "disabled" });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      // An unseen range must not display the previous query's events as if they belonged to it.
      await history.getByRole("button", { name: "Previous period", exact: true }).click();
      await expect(history).toContainText("Work history could not be loaded.");
      await expect(history.locator(".wd-row")).toHaveCount(0);
      await history.getByRole("button", { name: "Next period", exact: true }).click();
      await expect(history.locator(".wd-card-title").filter({ hasText: dependent.title })).toBeVisible();
      await page.getByRole("group", { name: "Work done layout", exact: true }).getByRole("button", { name: "Report", exact: true }).click();
      // History and its comparison are immutable here; the dependency edits above legitimately
      // change the report's separate "right now" section as card snapshots catch up.
      await expect(history.locator(".rp-sentence").first()).toHaveText(reportHeadline);
      await expect(comparison).toHaveText(reportComparison);
      await page.screenshot({ path: testInfo.outputPath("offline-work-done-report.png"), animations: "disabled" });
      expect(offlineWrites).toEqual([]);
      // Reconnecting refreshes the schedule and makes the same chart editable again.
      await select("Timeline view");
      await page.unroute("**/api/**");
      socket.restore();
      await page.evaluate(() => {
        Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
        window.dispatchEvent(new Event("online"));
      });
      await expect(timeline).not.toContainText("Offline copy from");
      await expect(timeline.locator(".tl-link-handle").first()).toBeAttached();
      await select("Dependencies view");
      await expect(map).not.toContainText("Offline copy from");
      await expect(map.locator(".dm-link-handle").first()).toBeAttached();
      await select("Work done");
      await expect(history).not.toContainText("Offline copy from");
      await expect(history.locator(".rp-headline")).toBeVisible();
    } finally {
      socket.restore();
      await page.unroute("**/api/**");
      await api.delete(`/api/workspaces/${workspace.id}`);
    }
  });
}
