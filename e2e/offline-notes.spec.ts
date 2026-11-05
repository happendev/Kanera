import { test, expect } from "./support/fixtures";
import { SocketLink } from "./support/socket";

test("workspace notes restore the selected cached body offline and refresh on reconnect", async ({ page, signIn, apiAs, testWorkspace, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const response = await api.post(`/api/workspaces/${testWorkspace.id}/notes`, {
    data: { scope: "team", title: uniqueName("Cached workspace note") },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const note = await response.json() as { id: string };
  expect((await api.patch(`/api/notes/${note.id}`, { data: { content: "Cached note body" } })).ok()).toBe(true);
  const socket = await SocketLink.install(page.context());
  await signIn(page, "amelia", `/w/${testWorkspace.id}/notes?noteId=${note.id}`);
  const viewer = page.locator("k-note-editor .ne-viewer");
  await expect(viewer).toContainText("Cached note body");
  await expect.poll(() => page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("kanera-offline");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open offline cache"));
    });
    try {
      return await new Promise<boolean>((resolve) => {
        const request = db.transaction("noteEntries").objectStore("noteEntries").getAll();
        request.onsuccess = () => resolve(request.result.some((row: { note: { id: string; content: string } }) => row.note.id === id && row.note.content === "Cached note body"));
      });
    } finally { db.close(); }
  }, note.id)).toBe(true);
  await socket.cut();
  await expect.poll(() => socket.refusedAttempts).toBeGreaterThan(0);
  await page.route("**/api/**", (route) => route.abort("internetdisconnected"));
  await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false }));
  await page.reload();
  await expect(viewer).toContainText("Cached note body");
  await expect(page).toHaveURL(new RegExp(`noteId=${note.id}`));
  await expect(page.getByRole("button", { name: "New note", exact: true })).toBeDisabled();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: testInfo.outputPath(`offline-notes-${width}.png`), animations: "disabled" });
  }
  expect((await api.patch(`/api/notes/${note.id}`, { data: { content: "Updated while offline" } })).ok()).toBe(true);
  await page.unroute("**/api/**");
  socket.restore();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
    window.dispatchEvent(new Event("online"));
  });
  await expect(viewer).toContainText("Updated while offline");
  await expect(page).toHaveURL(new RegExp(`noteId=${note.id}`));
});
