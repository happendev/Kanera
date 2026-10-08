import type { APIRequestContext, APIResponse, Route } from "@playwright/test";
import { expect, test } from "./support/fixtures";

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

async function fixture(api: APIRequestContext, name: string) {
  const workspace = await json<{ id: string; initialBoard: { id: string } }>(await api.post("/api/workspaces", {
    data: { name, initialBoard: { name }, listNames: ["To do", "Done"], customFields: [] },
  }));
  const boardId = workspace.initialBoard.id;
  const board = await json<{ lists: { id: string }[] }>(await api.get(`/api/boards/${boardId}?includeCards=false`));
  const me = await json<{ id?: string; user?: { id: string } }>(await api.get("/api/me"));
  return { boardId, workspaceId: workspace.id, listId: board.lists[0]!.id, userId: me.user?.id ?? me.id! };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("long description history keeps exact changed words when the diff is opened", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const board = await fixture(api, uniqueName("Long description history"));
  const original = Array.from({ length: 2500 }, (_, index) => `word${index}`).join(" ");
  const updated = original.replace("word1 ", "replacement1 ");
  const title = uniqueName("Long description card");
  const card = await json<{ id: string }>(await api.post(`/api/boards/${board.boardId}/lists/${board.listId}/cards`, { data: { title, description: original } }));
  await json(await api.patch(`/api/cards/${card.id}`, { data: { description: updated } }));
  await signIn(page, "amelia");
  await page.goto(`/b/${board.boardId}/c/${card.id}`);
  const detail = page.getByRole("dialog", { name: `Card detail: ${title}` });
  await expect(detail).toBeVisible();
  await detail.getByRole("button", { name: /View changes/ }).click();
  const diff = page.getByRole("dialog", { name: /Description changes/ });
  await expect(diff.locator(".is-removed .is-changed")).toHaveText("word1");
  await expect(diff.locator(".is-added .is-changed")).toHaveText("replacement1");
  // This is the rendered feed-to-modal integration guard: neither lazy eligibility nor the
  // bounded-memory algorithm may truncate text. CPU/heap regression checks live in the repeatable
  // benchmarks/performance/frontend.mjs comparison rather than machine-dependent E2E deadlines.
  await expect(diff.locator(".is-removed .description-diff-unified-text")).toHaveText(original);
  await expect(diff.locator(".is-added .description-diff-unified-text")).toHaveText(updated);
  await diff.screenshot({ path: testInfo.outputPath("long-description-exact-diff.png") });
  await testInfo.attach("reproduction.json", { body: JSON.stringify({ command: "pnpm test:e2e -- e2e/performance-frontend.spec.ts", boardId: board.boardId, cardId: card.id, words: 2500, changedToken: "word1" }), contentType: "application/json" });
});

test("Global Work queues events behind one background request and retains the latest edit", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const board = await fixture(api, uniqueName("Serialized Global Work"));
  const prefix = uniqueName("Serialized card");
  const card = await json<{ id: string }>(await api.post(`/api/boards/${board.boardId}/lists/${board.listId}/cards`, { data: { title: prefix, assigneeIds: [board.userId] } }));
  await signIn(page, "amelia");
  await page.goto("/my-cards");
  await page.getByRole("button", { name: "Table view", exact: true }).click();
  // The row is already present before the debounced search completes. Wait for that foreground
  // query before measuring background reconciliation, otherwise the held request can be the search.
  const searched = page.waitForResponse((response) => response.url().endsWith("/api/work/cards/query")
    && (response.request().postDataJSON() as { filters?: { q?: string } }).filters?.q === prefix);
  await page.getByRole("searchbox", { name: "Search cards" }).fill(prefix);
  await (await searched).finished();
  await expect(page.getByRole("button", { name: "New card", exact: true })).toBeEnabled();
  const row = page.locator(`.tv-row[data-card-id="${card.id}"]`);
  await expect(row).toBeVisible();
  const release = gate();
  let requests = 0;
  let active = 0;
  let peakConcurrent = 0;
  let firstResponseHeld = false;
  const completedTitles: string[] = [];
  const pendingHandlers = new Set<Promise<void>>();
  const serveRefresh = async (route: Route) => {
    const requestNumber = ++requests;
    active += 1;
    peakConcurrent = Math.max(peakConcurrent, active);
    try {
      const response = await route.fetch({ timeout: 10_000 });
      const body = await response.json() as { cards: { id: string; title: string }[] };
      if (requestNumber === 1) { firstResponseHeld = true; await release.promise; }
      await route.fulfill({ response });
      completedTitles.push(body.cards.find((entry) => entry.id === card.id)?.title ?? "<missing>");
    } finally { active -= 1; }
  };
  const holdFirstRefresh = (route: Route) => {
    const pending = serveRefresh(route);
    pendingHandlers.add(pending);
    void pending.then(() => pendingHandlers.delete(pending), () => pendingHandlers.delete(pending));
    return pending;
  };
  await page.route("**/api/work/cards/query", holdFirstRefresh);
  try {
    await json(await api.patch(`/api/cards/${card.id}`, { data: { title: `${prefix} first` } }));
    // A broken refresh must fail a bounded assertion, rather than leave an unresolved gate until
    // the whole test times out. Cleanup below releases the response even if setup/assertions fail.
    await expect.poll(() => firstResponseHeld).toBe(true);
    for (const suffix of ["second", "latest"]) {
      await json(await api.patch(`/api/cards/${card.id}`, { data: { title: `${prefix} ${suffix}` } }));
      await expect(row.locator('[data-col="title"]')).toContainText(`${prefix} ${suffix}`);
      // Longer than the 180ms realtime debounce: the original implementation starts overlapping
      // requests here. Holding a real response makes this independent of machine/server speed.
      await page.waitForTimeout(250);
    }
    expect(requests, "later events must wait behind the held background response").toBe(1);
    release.release();
    // Socket patches alone can show the latest title even if the queued refresh was dropped.
    // Require a completed authoritative response containing it, without fixing the final count.
    await expect.poll(() => completedTitles.includes(`${prefix} latest`)).toBe(true);
    await expect.poll(() => active).toBe(0);
    expect(peakConcurrent).toBe(1);
    await expect(row.locator('[data-col="title"]')).toContainText(`${prefix} latest`);
    await expect(page.getByRole("button", { name: "New card", exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("serialized-global-work-latest-edit.png") });
  } finally {
    release.release();
    // Removing interception before the released handler fulfills can auto-handle its route and
    // obscure the intended failure with "Route is already handled". Drain every active handler,
    // including a queued refresh admitted during the drain, before removing this interception.
    let cleanupTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => { while (pendingHandlers.size) await Promise.allSettled([...pendingHandlers]); })(),
        new Promise<never>((_, reject) => {
          cleanupTimeout = setTimeout(() => reject(new Error("Timed out draining Global Work response handlers")), 12_000);
        }),
      ]);
    } finally {
      clearTimeout(cleanupTimeout);
      await page.unroute("**/api/work/cards/query", holdFirstRefresh);
    }
  }
  await testInfo.attach("reconciliation.json", { body: JSON.stringify({ command: "pnpm test:e2e -- e2e/performance-frontend.spec.ts", boardId: board.boardId, cardId: card.id, requests, peakConcurrent, completedTitles }), contentType: "application/json" });
});

interface NoteCacheProbe {
  writes: { store: string; bytes: number; containsEditedTitle: boolean }[];
  pendingTransactions: number;
  editedTitle: string;
}

test("editing one note preserves every offline body without rewriting the other documents", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const board = await fixture(api, uniqueName("Incremental offline notes"));
  const notes: { id: string; title: string; body: string; noteRecordBytes: number }[] = [];
  for (let index = 0; index < 4; index += 1) {
    const title = uniqueName(`Complete note ${index}`);
    const created = await json<{ id: string }>(await api.post(`/api/boards/${board.boardId}/notes`, { data: { scope: "team", title } }));
    const body = `Retained content ${index}. ` + Array.from({ length: 500 }, (_, part) => `Complete offline note ${index}, segment ${part}.`).join(" ") + ` End of note ${index}.`;
    const noteRecord = await json<Record<string, unknown>>(await api.patch(`/api/notes/${created.id}`, { data: { content: body } }));
    notes.push({ ...created, title, body, noteRecordBytes: Buffer.byteLength(JSON.stringify(noteRecord)) });
  }
  const renamed = `${notes[0]!.title} renamed`;
  let editEchoReceived = false;
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
    const frame = String(payload);
    if (frame.includes("note:updated") && frame.includes(notes[0]!.id) && frame.includes(renamed)) editEchoReceived = true;
  }));
  await page.addInitScript(() => {
    const browser = window as unknown as { noteCacheProbe: NoteCacheProbe };
    browser.noteCacheProbe = { writes: [], pendingTransactions: 0, editedTitle: "" };
    const transactions = new WeakSet<IDBTransaction>();
    // Count committed payload bytes across both legacy whole snapshots and normalized records.
    // This tests write amplification, not a required store layout or a particular put count.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      const isNoteWrite = this.name.startsWith("note")
        || (this.name === "cacheMeta" && (value as { store?: string } | null)?.store === "notes");
      if (isNoteWrite) {
        const serialized = JSON.stringify(value);
        const record = {
          store: this.name,
          bytes: new TextEncoder().encode(serialized).length,
          containsEditedTitle: !!browser.noteCacheProbe.editedTitle && serialized.includes(browser.noteCacheProbe.editedTitle),
        };
        const transaction = this.transaction;
        if (!transactions.has(transaction)) {
          transactions.add(transaction);
          browser.noteCacheProbe.pendingTransactions += 1;
          const settled = () => { browser.noteCacheProbe.pendingTransactions -= 1; };
          transaction.addEventListener("complete", settled, { once: true });
          transaction.addEventListener("abort", settled, { once: true });
        }
        transaction.addEventListener("complete", () => browser.noteCacheProbe.writes.push(record), { once: true });
      }
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
  });
  const readProbe = () => page.evaluate(() => (window as unknown as { noteCacheProbe: NoteCacheProbe }).noteCacheProbe);
  await signIn(page, "amelia");
  await page.goto(`/b/${board.boardId}?view=notes&noteId=${notes[0]!.id}`);
  const noteBody = page.locator("k-note-editor .ne-viewer .dv-body");
  await expect(noteBody).toHaveText(notes[0]!.body);
  const allBodyBytes = notes.reduce((bytes, note) => bytes + Buffer.byteLength(note.body), 0);
  await expect.poll(async () => (await readProbe()).writes.reduce((bytes, write) => bytes + write.bytes, 0)).toBeGreaterThanOrEqual(allBodyBytes);
  await expect.poll(async () => (await readProbe()).pendingTransactions).toBe(0);
  await page.evaluate((editedTitle) => {
    const probe = (window as unknown as { noteCacheProbe: NoteCacheProbe }).noteCacheProbe;
    probe.writes = [];
    probe.editedTitle = editedTitle;
  }, renamed);
  const editResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/notes/${notes[0]!.id}`));
  await page.locator("k-note-editor .ne-title").click();
  await page.locator("k-note-editor .ne-title-input").fill(renamed);
  await page.locator("k-note-editor .ne-title-input").press("Enter");
  await (await editResponse).finished();
  await expect(page.locator("k-note-editor .ne-title")).toHaveText(renamed);
  await expect.poll(() => editEchoReceived).toBe(true);
  // Let the delivered echo run through Angular before waiting for its IndexedDB transactions.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect.poll(async () => (await readProbe()).writes.some((write) => write.containsEditedTitle)).toBe(true);
  await expect.poll(async () => (await readProbe()).pendingTransactions).toBe(0);
  const { writes } = await readProbe();
  const editBytes = writes.reduce((bytes, write) => bytes + write.bytes, 0);
  // Budget the complete API note representation, including search metadata and attribution,
  // plus generous cache-manifest overhead. A full-tree rewrite or two complete copies of this
  // changed row (HTTP result + socket echo) still exceed the budget.
  const noteRecordBytes = notes[0]!.noteRecordBytes;
  const editBudgetBytes = Math.ceil(noteRecordBytes * 1.6);
  await testInfo.attach("note-writes.json", { body: JSON.stringify({ command: "pnpm test:e2e -- e2e/performance-frontend.spec.ts", boardId: board.boardId, noteIds: notes.map((note) => note.id), writes, editBytes, editBudgetBytes, noteRecordBytes, allBodyBytes }), contentType: "application/json" });
  expect(editBytes).toBeLessThan(editBudgetBytes);

  // NotesState is provided by k-notes-view. Prove its old host is destroyed and that a recreated
  // view attempts both network scopes while offline, so existing in-memory notes cannot pass.
  const originalView = await page.locator("k-notes-view").elementHandle();
  const failedOfflineScopes = new Set<string>();
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/api/boards/${board.boardId}/notes`) failedOfflineScopes.add(url.searchParams.get("scope") ?? "");
  });
  await page.context().setOffline(true);
  try {
    await page.getByRole("button", { name: "Board view", exact: true }).click();
    await expect(page.locator("k-notes-view")).toHaveCount(0);
    expect(await originalView!.evaluate((element) => element.isConnected)).toBe(false);
    await page.getByRole("button", { name: "Board Notes", exact: true }).click();
    await expect.poll(() => [...failedOfflineScopes].sort()).toEqual(["personal", "team"]);
    await page.getByRole("tab", { name: /Team/ }).click();
    for (const [index, note] of notes.entries()) {
      await page.locator("k-notes-tree").getByText(index === 0 ? renamed : note.title, { exact: true }).click();
      await expect(noteBody).toHaveText(note.body);
    }
    await page.screenshot({ path: testInfo.outputPath("complete-notes-offline.png") });
  } finally {
    await page.context().setOffline(false);
    await originalView?.dispose();
  }
  await testInfo.attach("offline-restoration.json", { body: JSON.stringify({ boardId: board.boardId, noteIds: notes.map((note) => note.id), failedOfflineScopes: [...failedOfflineScopes], fullBodiesMatched: notes.length }), contentType: "application/json" });
});

test("a burst of realtime events on a deep table coalesces into one background walk", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  test.setTimeout(150_000);
  const api = await apiAs("amelia");
  const board = await fixture(api, uniqueName("Deep table burst"));
  const prefix = uniqueName("Deep table card");
  const cards: { id: string }[] = [];
  for (let offset = 0; offset < 201; offset += 5) {
    const batch = Array.from({ length: Math.min(5, 201 - offset) }, (_, index) =>
      api.post(`/api/boards/${board.boardId}/lists/${board.listId}/cards`, { data: { title: `${prefix} ${String(offset + index).padStart(3, "0")}`, assigneeIds: [board.userId] } })
        .then((response) => json<{ id: string }>(response)));
    cards.push(...await Promise.all(batch));
  }
  await signIn(page, "amelia");
  await page.goto("/my-cards");
  await page.getByRole("button", { name: "Table view", exact: true }).click();
  const searched = page.waitForResponse((response) => response.url().endsWith("/api/work/cards/query")
    && (response.request().postDataJSON() as { filters?: { q?: string } }).filters?.q === prefix);
  await page.getByRole("searchbox", { name: "Search cards" }).fill(prefix);
  await (await searched).finished();
  const loadMore = page.getByRole("button", { name: "Load more", exact: true });
  for (let remaining = 2; remaining > 0; remaining -= 1) {
    await expect(loadMore).toBeEnabled();
    await loadMore.click();
  }
  await expect(loadMore).toHaveCount(0);
  // The table virtualises rows, so compare what is rendered rather than asserting all 201.
  const rowsBeforeRefresh = await page.locator(".tv-row").count();
  expect(rowsBeforeRefresh).toBeGreaterThan(50);

  // Every background walk of this three-page table costs three sequential queries. Three events
  // spaced inside the depth-scaled debounce must therefore produce one first-page refresh, where a
  // fixed 180 ms debounce started a second walk as soon as the first one had settled.
  const walks: { cursor: boolean; at: number }[] = [];
  let armed = false;
  page.on("request", (request) => {
    if (!armed || !request.url().endsWith("/api/work/cards/query")) return;
    const body = request.postDataJSON() as { cursor?: string; filters?: { q?: string } };
    if (body.filters?.q === prefix) walks.push({ cursor: Boolean(body.cursor), at: Date.now() });
  });
  armed = true;
  const burstStartedAt = Date.now();
  for (const suffix of ["first", "second", "latest"]) {
    await json(await api.patch(`/api/cards/${cards[0]!.id}`, { data: { title: `${prefix} ${suffix}` } }));
    await page.waitForTimeout(300);
  }
  await expect(page.locator(".tv-row").filter({ hasText: `${prefix} latest` })).toHaveCount(1);
  await page.waitForTimeout(2_500);
  const firstPageRefreshes = walks.filter((walk) => !walk.cursor).length;
  const continuations = walks.filter((walk) => walk.cursor).length;
  await testInfo.attach("burst-walks.json", { body: JSON.stringify({ command: "pnpm test:e2e -- e2e/performance-frontend.spec.ts", boardId: board.boardId, burstStartedAt, walks, firstPageRefreshes, continuations }), contentType: "application/json" });
  expect(firstPageRefreshes).toBe(1);
  expect(continuations).toBe(2);
  await expect(page.locator(".tv-row")).toHaveCount(rowsBeforeRefresh);
  await expect(loadMore).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("table-burst-single-walk.png") });
});
