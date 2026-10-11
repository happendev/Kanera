import type { APIRequestContext, APIResponse, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { expectBoardLoaded, openBoard } from "./support/ui";

// Every race holds a real response or mutation at the browser boundary. Tests deliberately let the
// realtime debounce elapse before releasing it; assertions then check the user's view and durable API.
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

async function ownBoard(api: APIRequestContext, name: string) {
  const workspace = await json<{ id: string; initialBoard: { id: string } }>(await api.post("/api/workspaces", {
    data: { name, initialBoard: { name }, listNames: ["To do", "Done"], customFields: [] },
  }));
  const boardId = workspace.initialBoard.id;
  const board = await json<{ lists: { id: string }[] }>(await api.get(`/api/boards/${boardId}?includeCards=false`));
  const me = await json<{ id?: string; user?: { id: string } }>(await api.get("/api/me"));
  return { workspaceId: workspace.id, boardId, listId: board.lists[0]!.id, userId: me.user?.id ?? me.id! };
}

async function addCard(api: APIRequestContext, board: Awaited<ReturnType<typeof ownBoard>>, title: string) {
  return json<{ id: string }>(await api.post(`/api/boards/${board.boardId}/lists/${board.listId}/cards`, {
    data: { title, assigneeIds: [board.userId] },
  }));
}

async function table(page: Page) {
  await page.getByRole("button", { name: "Table view", exact: true }).click();
  await expect(page.locator("k-board-table-view")).toBeVisible();
}

test("a completed-filter response cannot replace the board opened afterward", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const firstName = uniqueName("Filter source");
  const secondName = uniqueName("Filter destination");
  const board = await ownBoard(api, firstName);
  await json(await api.post(`/api/workspaces/${board.workspaceId}/boards`, { data: { name: secondName } }));
  await signIn(page, "amelia");
  await openBoard(page, firstName);
  const captured = gate();
  const release = gate();
  await page.route(`**/api/boards/${board.boardId}/open?*`, async (route) => {
    const response = await route.fetch();
    captured.release();
    await release.promise;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.locator(".fb-row").filter({ hasText: /^Completed$/ }).click();
  await page.getByRole("button", { name: "7 days", exact: true }).click();
  await captured.promise;
  await openBoard(page, secondName);
  const delivered = page.waitForResponse((response) => response.url().includes(`/boards/${board.boardId}/open?`));
  release.release();
  await (await delivered).finished();
  // Let the released fetch and the cache's 250ms coalescing window both finish before asserting.
  await page.waitForTimeout(400);
  await expectBoardLoaded(page, secondName);
  await expect(page.getByRole("heading", { level: 1, name: firstName, exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("completed-filter-route-race.png") });
});

test("Global Work stays editable when realtime arrives during a foreground query", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const socketFrames: string[] = [];
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => socketFrames.push(String(payload))));
  const api = await apiAs("amelia");
  const title = uniqueName("Foreground race");
  const board = await ownBoard(api, uniqueName("Foreground workspace"));
  const card = await addCard(api, board, title);
  await signIn(page, "amelia");
  await page.goto("/my-cards");
  await table(page);
  await page.getByRole("searchbox", { name: "Search cards" }).fill(title);
  await expect(page.locator(`.tv-row[data-card-id="${card.id}"]`)).toBeVisible();
  const nextQuery = title.slice(0, -1);
  const captured = gate();
  const release = gate();
  let held = false;
  await page.route("**/api/work/cards/query", async (route) => {
    const body = route.request().postDataJSON() as { filters?: { q?: string } };
    if (held || body.filters?.q !== nextQuery) { await route.continue(); return; }
    held = true;
    const response = await route.fetch();
    captured.release();
    await release.promise;
    await route.fulfill({ response });
  });
  await page.getByRole("searchbox", { name: "Search cards" }).fill(nextQuery);
  await captured.promise;
  const renamed = `${title} edited`;
  await json(await api.patch(`/api/cards/${card.id}`, { data: { title: renamed } }));
  // Foreground loading can unmount the table; prove delivery through the transport instead.
  await expect.poll(() => socketFrames.some((frame) => frame.includes("card:updated") && frame.includes(card.id) && frame.includes(renamed))).toBe(true);
  // The production realtime debounce is 180ms; let it run while the foreground response is held.
  await page.waitForTimeout(300);
  release.release();
  await expect(page.getByRole("button", { name: "New card", exact: true })).toBeEnabled();
  await expect(page.locator(`.tv-row[data-card-id="${card.id}"] [data-col="title"]`)).toContainText(renamed);
  await page.screenshot({ path: testInfo.outputPath("foreground-query-realtime.png") });
});

test("Home leaves its loading skeleton after an event during its initial request", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const captured = gate();
  const release = gate();
  let held = false;
  await page.route("**/api/home/today?*", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { items: unknown[]; counts: Record<string, number> };
    // Model a valid empty agenda, making loading observable without private Angular state. Keep
    // real board/plan metadata; only this test's agenda projection is empty on every request.
    body.items = [];
    body.counts = Object.fromEntries(Object.keys(body.counts).map((key) => [key, 0]));
    if (!held) {
      held = true;
      captured.release();
      await release.promise;
    }
    await route.fulfill({ response, json: body });
  });
  await signIn(page, "amelia");
  await captured.promise;
  const createdName = uniqueName("Home event workspace");
  await ownBoard(api, createdName);
  // board:created is delivered through the user room even before the agenda has joined any board.
  await expect(page.locator("a.board-link").filter({ hasText: createdName }).first()).toBeVisible();
  await page.waitForTimeout(300);
  release.release();
  await expect(page.getByLabel("Loading your day", { exact: true })).toHaveCount(0);
  await expect(page.getByText("You're all clear", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("home-initial-realtime.png") });
});

test("Global Work retains loaded table pages after a realtime edit", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  test.setTimeout(120_000);
  const api = await apiAs("amelia");
  const prefix = uniqueName("Pagination race");
  const board = await ownBoard(api, uniqueName("Pagination workspace"));
  const cards: { id: string }[] = [];
  // Bounded batches keep setup quick without creating a hundred concurrent ordering writes.
  for (let offset = 0; offset < 101; offset += 5) {
    const batch = Array.from({ length: Math.min(5, 101 - offset) }, (_, index) => addCard(api, board, `${prefix} ${String(offset + index).padStart(3, "0")}`));
    cards.push(...await Promise.all(batch));
  }
  await signIn(page, "amelia");
  await page.goto("/my-cards");
  await table(page);
  await page.getByRole("searchbox", { name: "Search cards" }).fill(prefix);
  const loadMore = page.getByRole("button", { name: "Load more", exact: true });
  await expect(loadMore).toBeEnabled();
  await loadMore.click();
  await expect(loadMore).toHaveCount(0);
  const reconciled = page.waitForResponse((response) => {
    if (!response.url().endsWith("/work/cards/query")) return false;
    const request = response.request().postDataJSON() as { filters?: { q?: string }; cursor?: string };
    return request.filters?.q === prefix && !request.cursor;
  });
  await json(await api.patch(`/api/cards/${cards[0]!.id}`, { data: { title: `${prefix} renamed` } }));
  await (await reconciled).finished();
  await page.waitForTimeout(400);
  await expect(loadMore).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New card", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("table-pagination-realtime.png") });
});

test("table multi-select clicks preserve both choices before the first request settles", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const name = uniqueName("Table selection workspace");
  const board = await ownBoard(api, name);
  const card = await addCard(api, board, uniqueName("Table selection card"));
  const field = await json<{ id: string; options: { id: string; label: string }[] }>(await api.post(`/api/workspaces/${board.workspaceId}/custom-fields`, {
    data: { name: "Race choices", type: "select", allowMultiple: true, options: [{ label: "Alpha" }, { label: "Beta" }] },
  }));
  await signIn(page, "amelia");
  await openBoard(page, name);
  await table(page);
  const captured = gate();
  const release = gate();
  let held = false;
  await page.route(`**/api/cards/${card.id}/custom-fields/${field.id}`, async (route) => {
    if (route.request().method() !== "PUT" || held) { await route.continue(); return; }
    held = true;
    captured.release();
    // Hold the mutation itself so no server echo can accidentally make the second click safe.
    await release.promise;
    await route.continue();
  });
  const cell = page.locator(`.tv-row[data-card-id="${card.id}"] [data-col="cf:${field.id}"]`);
  await cell.locator(".tv-cell-trigger").click();
  await page.locator("k-select-picker").getByRole("button", { name: "Alpha", exact: true }).click();
  await captured.promise;
  await page.locator("k-select-picker").getByRole("button", { name: "Beta", exact: true }).click();
  release.release();
  await expect.poll(async () => {
    const detail = await json<{ customFieldValues: { fieldId: string; valueOptionIds: string[] | null }[] }>(await api.get(`/api/cards/${card.id}/detail`));
    return detail.customFieldValues.find((value) => value.fieldId === field.id)?.valueOptionIds?.slice().sort() ?? [];
  }).toEqual(field.options.map((option) => option.id).sort());
  await page.keyboard.press("Escape");
  await expect(cell).toContainText("Alpha, Beta");
  await page.screenshot({ path: testInfo.outputPath("table-multiselect-queued.png") });
});

for (const surface of ["detail", "table"] as const) {
  for (const remote of ["set", "clear"] as const) {
    test(`${surface} keeps a newer remote field ${remote} after an older save acknowledgement`, async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
      const api = await apiAs("amelia");
      const name = uniqueName(`Field ack ${surface} ${remote}`);
      const title = uniqueName(`Field ack ${surface} ${remote} card`);
      const board = await ownBoard(api, name);
      const card = await addCard(api, board, title);
      const field = await json<{ id: string; options: { id: string; label: string }[] }>(await api.post(`/api/workspaces/${board.workspaceId}/custom-fields`, {
        data: { name: "Acknowledgement choices", type: "select", allowMultiple: true, options: [{ label: "Alpha" }, { label: "Beta" }] },
      }));
      const beta = field.options.find((option) => option.label === "Beta")!.id;
      const frames: string[] = [];
      page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => frames.push(String(payload))));
      await signIn(page, "amelia");
      await openBoard(page, name);
      if (surface === "table") await table(page);
      else {
        await page.locator("k-card").filter({ hasText: title }).click();
        await expect(page.getByRole("dialog", { name: `Card detail: ${title}` })).toBeVisible();
      }
      const trigger = surface === "table"
        ? page.locator(`.tv-row[data-card-id="${card.id}"] [data-col="cf:${field.id}"] .tv-cell-trigger`)
        : page.locator(".cf-row").filter({ hasText: "Acknowledgement choices" }).locator(".cf-trigger");
      const committed = gate();
      const release = gate();
      const delivered = gate();
      let held = false;
      await page.route(`**/api/cards/${card.id}/custom-fields/${field.id}`, async (route) => {
        if (route.request().method() !== "PUT" || held) { await route.continue(); return; }
        held = true;
        // Commit our value and let its echo arrive, holding only the older HTTP acknowledgement.
        const response = await route.fetch();
        committed.release();
        await release.promise;
        await route.fulfill({ response });
        delivered.release();
      });
      try {
        await trigger.click();
        await page.locator("k-select-picker").getByRole("button", { name: "Alpha", exact: true }).click();
        await committed.promise;
        await json(await api.put(`/api/cards/${card.id}/custom-fields/${field.id}`, { data: { valueOptionIds: [beta] } }));
        await expect.poll(() => frames.some((frame) => frame.includes("card:customFieldValue:set") && frame.includes(card.id) && frame.includes(beta))).toBe(true);
        if (remote === "clear") {
          const cleared = await api.delete(`/api/cards/${card.id}/custom-fields/${field.id}`);
          expect(cleared.ok(), await cleared.text()).toBe(true);
          await expect.poll(() => frames.some((frame) => frame.includes("card:customFieldValue:cleared") && frame.includes(card.id) && frame.includes(field.id))).toBe(true);
        }
        release.release();
        await delivered.promise;
        await page.keyboard.press("Escape");
        await expect(trigger).toHaveText(remote === "set" ? "Beta" : surface === "detail" ? "Set value" : "—");
        await page.screenshot({ path: testInfo.outputPath(`${surface}-newer-field-${remote}-echo.png`) });
      } finally {
        release.release();
      }
    });
  }
}
