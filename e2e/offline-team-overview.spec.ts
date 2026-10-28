import type { APIResponse } from "@playwright/test";
import { test, expect } from "./support/fixtures";
import { SocketLink } from "./support/socket";

async function result<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

test("Team overview and a teammate's queue survive offline reloads, stay read-only and refresh on reconnect", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const teammate = await apiAs("priya");
  const person = await result<{ id: string; displayName: string }>(await teammate.get("/api/me"));
  const workspace = await result<{ id: string; initialBoard: { id: string } }>(await api.post("/api/workspaces", {
    data: { name: uniqueName("Offline team"), initialBoard: { name: uniqueName("Team cache") } },
  }));
  const socket = await SocketLink.install(page.context());
  try {
    await result(await api.post(`/api/workspaces/${workspace.id}/members`, { data: { userId: person.id, role: "admin" } }));
    const board = await result<{ lists: { id: string }[] }>(await api.get(`/api/boards/${workspace.initialBoard.id}?includeCards=false`));
    const title = uniqueName("Offline team work");
    const make = async (suffix: string, assigneeIds: string[]) => result<{ id: string; title: string }>(await teammate.post(`/api/boards/${workspace.initialBoard.id}/lists/${board.lists[0]!.id}/cards`, { data: { title: `${title} ${suffix}`, assigneeIds } }));
    const queued = await make("queued", [person.id]);
    const active = await make("recently active", [person.id]);
    await result(await api.patch(`/api/lists/${board.lists[1]!.id}`, { data: { inProgress: true } }));
    const unowned = await make("unowned", []);
    await result(await teammate.post(`/api/cards/${unowned.id}/move`, { data: { listId: board.lists[1]!.id, afterCardId: null } }));
    await result(await teammate.post(`/api/work/priorities/${person.id}/cards`, { data: { cardId: queued.id, afterId: null } }));
    await signIn(page, "amelia");
    await page.goto("/team-cards");
    await page.getByRole("searchbox", { name: "Search cards", exact: true }).fill(title);
    await page.getByRole("button", { name: "Team overview", exact: true }).click();
    const overview = page.locator("k-team-overview");
    const dock = page.locator("k-up-next-panel");
    const personPanel = overview.locator("section.person").filter({ has: page.locator(".person-name", { hasText: person.displayName }) });
    await expect(personPanel.locator(".tone-recent")).toContainText(active.title);
    await expect(overview.locator("section.unowned")).toContainText(unowned.title);
    await personPanel.getByRole("button", { name: `Edit Up next for ${person.displayName}`, exact: true }).click();
    await expect(dock).toContainText(queued.title);
    await expect(dock.getByRole("button", { name: "Add card to Up next", exact: true })).toBeVisible();
    // Disable an already-open picker in the first rendered offline frame, before the cosmetic
    // connection banner's 1.5-second debounce. A delayed guard leaves a real click window.
    await dock.getByRole("button", { name: "Add card to Up next", exact: true }).click();
    const controlsRemain = await page.evaluate(async () => {
      window.dispatchEvent(new Event("offline"));
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return !!document.querySelector('k-up-next-panel [aria-label="Add card to Up next"], k-up-next-panel k-anchored-picker');
    });
    expect(controlsRemain).toBe(false);
    await socket.cut();
    await expect.poll(() => socket.refusedAttempts).toBeGreaterThan(0);
    await page.route("**/api/**", (route) => route.abort("internetdisconnected"));
    const writes: string[] = [];
    page.on("request", (request) => {
      if (["POST", "DELETE", "PATCH"].includes(request.method()) && /\/api\/(?:card-priorities|work\/priorities)\//.test(request.url())) writes.push(request.url());
    });
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(dock.getByRole("button", { name: "Add card to Up next", exact: true })).toHaveCount(0);
    await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false }));
    await page.reload();
    await expect(overview).toBeVisible();
    // One "saved copy" message: the page's banner, not a second note inside the overview.
    await expect(page.locator(".offline-banner")).toHaveCount(1);
    await expect(overview.locator(".overview-offline")).toHaveCount(0);
    await expect(personPanel.locator(".tone-recent")).toContainText(active.title);
    await expect(overview.locator("section.unowned")).toContainText(unowned.title);
    await expect(personPanel.locator(".tone-next")).toContainText(queued.title);
    await overview.getByRole("button", { name: `Show only ${person.displayName}`, exact: true }).first().click();
    await expect(dock).toContainText(queued.title);
    await expect(dock).toContainText("Offline copy from");
    await expect(dock.locator(".panel-row.cdk-drag:not(.cdk-drag-disabled)")).toHaveCount(0);
    await expect(dock.getByRole("button", { name: "Add card to Up next", exact: true })).toHaveCount(0);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: testInfo.outputPath(`offline-team-overview-${width}.png`), animations: "disabled" });
    }
    expect(writes).toEqual([]);
    await page.setViewportSize({ width: 1280, height: 900 });
    await result(await teammate.patch(`/api/cards/${queued.id}`, { data: { title: `${queued.title} updated` } }));
    await page.unroute("**/api/**");
    socket.restore();
    await page.evaluate(() => {
      Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
      window.dispatchEvent(new Event("online"));
    });
    await expect(dock).toContainText(`${queued.title} updated`);
    await expect(dock.getByRole("button", { name: "Add card to Up next", exact: true })).toBeVisible();
    // The focused-person Board has its own queue endpoint and must restore that snapshot too.
    await personPanel.getByRole("button", { name: `Open ${person.displayName}’s cards`, exact: true }).click();
    await expect(dock).toContainText(`${queued.title} updated`);
    await socket.cut();
    await page.route("**/api/**", (route) => route.abort("internetdisconnected"));
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await page.reload();
    await expect(dock).toContainText(`${queued.title} updated`);
    await expect(dock).toContainText("Offline copy from");
    await expect(dock.getByRole("button", { name: "Add card to Up next", exact: true })).toHaveCount(0);
  } finally {
    socket.restore();
    await page.unroute("**/api/**");
    await api.delete(`/api/workspaces/${workspace.id}`);
  }
});
