import { test, expect } from "./support/fixtures";
import { SocketLink } from "./support/socket";

for (const lens of ["my", "team"] as const) {
  test(`${lens} cards skips brief foreground reloads and recovers after dirty events, long absences and reconnects`, async ({ page, context, signIn, apiAs, testWorkspace, uniqueName }, testInfo) => {
    const api = await apiAs("amelia");
    // Team Cards excludes the viewer; use a real teammate assignment for that lens.
    const assigneeApi = await apiAs(lens === "team" ? "priya" : "amelia");
    const assigneeResponse = await assigneeApi.get("/api/me");
    expect(assigneeResponse.ok()).toBe(true);
    const assignee = await assigneeResponse.json() as { id: string };
    const title = uniqueName("Foreground work");
    const created = await api.post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")!}/cards`, {
      data: { title, assigneeIds: [assignee.id] },
    });
    expect(created.ok()).toBe(true);
    const card = await created.json() as { id: string };
    const socket = await SocketLink.install(context);
    const paths = ["/api/work/cards/query", "/api/work/catalog", "/api/work-views", "/api/work-views/share-candidates"];
    const requests = new Map(paths.map((path) => [path, 0]));
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (requests.has(path)) requests.set(path, requests.get(path)! + 1);
    });
    await signIn(page, "amelia", `/${lens}-cards`);
    const cardTitle = (value: string) => page.getByText(value, { exact: true }).first();
    await expect(cardTitle(title)).toBeVisible();
    await page.waitForTimeout(500);
    const initial = new Map(requests);
    const visibility = async (value: "hidden" | "visible") => page.evaluate((state) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
      document.dispatchEvent(new Event("visibilitychange"));
    }, value);
    await visibility("hidden");
    await visibility("visible");
    // Negative window exceeds the page's 180 ms reconcile debounce on this single-card view.
    await page.waitForTimeout(1_000);
    expect(requests).toEqual(initial);

    await visibility("hidden");
    const updatedTitle = `${title} updated`;
    expect((await api.patch(`/api/cards/${card.id}`, { data: { title: updatedTitle } })).ok()).toBe(true);
    // The realtime row patch proves the event arrived while hidden, before its queued query runs.
    await expect(cardTitle(updatedTitle)).toBeVisible();
    expect(requests).toEqual(initial);
    await visibility("visible");
    await expect.poll(() => requests.get("/api/work/cards/query")!).toBeGreaterThan(initial.get("/api/work/cards/query")!);
    await page.waitForTimeout(500);
    // Returning with a queued card edit must not promote it into a catalog/saved-view refresh.
    for (const path of paths.filter((value) => value !== "/api/work/cards/query")) {
      expect(requests.get(path), path).toBe(initial.get(path));
    }

    const beforeLongAbsence = new Map(requests);
    await page.clock.setFixedTime(new Date());
    await visibility("hidden");
    await page.clock.setFixedTime(new Date(Date.now() + 61_000));
    await visibility("visible");
    for (const path of paths) {
      await expect.poll(() => requests.get(path)!).toBeGreaterThan(beforeLongAbsence.get(path)!);
    }
    await page.waitForTimeout(500);

    await socket.cut();
    await expect.poll(() => socket.refusedAttempts).toBeGreaterThan(0);
    const reconnectedTitle = `${title} recovered`;
    expect((await api.patch(`/api/cards/${card.id}`, { data: { title: reconnectedTitle } })).ok()).toBe(true);
    await page.waitForTimeout(1_000);
    await expect(cardTitle(reconnectedTitle)).toHaveCount(0);
    socket.restore();
    await expect(cardTitle(reconnectedTitle)).toBeVisible();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: testInfo.outputPath(`${lens}-foreground-${width}.png`), animations: "disabled" });
    }
  });
}
