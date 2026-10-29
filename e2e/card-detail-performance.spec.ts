import type { APIResponse, Locator, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { openCard } from "./support/ui";
import ports from "./ports.json";

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

async function dragItem(page: Page, source: Locator, target: Locator) {
  await source.scrollIntoViewIfNeeded();
  const from = (await source.locator(".checklist-item-grip").boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height * 0.8, { steps: 20 });
  const moved = page.waitForResponse((response) => /\/items\/[^/]+\/move$/.test(response.url()) && response.request().method() === "POST");
  await page.mouse.up();
  expect((await moved).ok()).toBe(true);
}

test("large card sections stay isolated, cache bursts coalesce and checklist drags preserve order", async ({ page, apiAs, signIn, testWorkspace, uniqueName }, testInfo) => {
  test.setTimeout(180_000);
  const api = await apiAs("amelia");
  const card = await json<{ id: string; title: string }>(await api.post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")}/cards`, { data: { title: uniqueName("Large card") } }));
  const checklist = await json<{ id: string; items: { id: string; text: string }[] }>(await api.post(`/api/cards/${card.id}/checklists`, {
    data: { title: "Large checklist", items: Array.from({ length: 150 }, (_, index) => ({ text: `Item ${String(index).padStart(3, "0")}` })) },
  }));
  const other = await json<{ id: string }>(await api.post(`/api/cards/${card.id}/checklists`, { data: { title: "Drop destination", items: [{ text: "Destination item" }] } }));
  for (let index = 0; index < 55; index++) {
    await json(await api.post(`/api/cards/${card.id}/attachments`, {
      multipart: { file: { name: `large-card-${index}.txt`, mimeType: "text/plain", buffer: Buffer.from(`Fixture attachment ${index}`) } },
    }));
  }
  for (let index = 0; index < 55; index++) {
    await json(await api.post(`/api/cards/${card.id}/comments`, { data: { body: `Fixture comment ${index}` } }));
  }
  await page.addInitScript(() => {
    const browser = window as typeof window & { detailWrites: number };
    browser.detailWrites = 0;
    // Preserve the original receiver when instrumenting IndexedDB.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === "cardDetails") browser.detailWrites++;
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
  });
  const requests = { detail: 0, feed: 0, read: 0 };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/api/cards/${card.id}/detail`) requests.detail++;
    if (url.pathname === `/api/cards/${card.id}/feed` && !url.searchParams.has("cursor")) requests.feed++;
    if (url.pathname === `/api/notifications/cards/${card.id}/read`) requests.read++;
  });
  await signIn(page, "amelia", `/b/${testWorkspace.boardId}`);
  const detail = await openCard(page, card.title);
  await expect(detail.locator(".checklist-item")).toHaveCount(151);
  await expect(detail.locator(".attach-row")).toHaveCount(55);
  await expect(detail.locator(".comment").first()).toBeVisible();
  await expect.poll(() => requests).toEqual({ detail: 1, feed: 1, read: 1 });
  const openRequests = { ...requests };
  const reads = await detail.locator("k-card-detail-checklists").evaluate((element) => {
    type Model = { visibleChecklistItems: (...args: unknown[]) => unknown };
    const browser = window as typeof window & { ng: { getComponent: (element: Element) => { model: () => Model } }; checklistReads: number };
    browser.checklistReads = 0;
    const model = browser.ng.getComponent(element).model();
    const original = model.visibleChecklistItems;
    model.visibleChecklistItems = (...args) => { browser.checklistReads++; return original(...args); };
    return browser.checklistReads;
  });
  await detail.locator(".card-title").click();
  await detail.locator(".title-input").fill(`${card.title} draft`);
  await detail.locator(".title-input").press("Escape");
  expect(await page.evaluate(() => (window as typeof window & { checklistReads: number }).checklistReads)).toBe(reads);

  await detail.locator("k-card-detail-attachments").evaluate((element) => {
    const browser = window as typeof window & { ng: { getComponent: (element: Element) => { model: () => { attachmentDisplayById: () => Map<string, unknown> } } }; attachmentReads: number };
    browser.attachmentReads = 0;
    const displays = browser.ng.getComponent(element).model().attachmentDisplayById();
    const get = displays.get.bind(displays);
    displays.get = (key) => { browser.attachmentReads++; return get(key); };
  });
  await json(await api.patch(`/api/cards/${card.id}`, { data: { title: `${card.title} renamed` } }));
  await expect(detail.locator(".card-title")).toHaveText(`${card.title} renamed`);
  expect(await page.evaluate(() => (window as typeof window & { attachmentReads: number }).attachmentReads)).toBe(0);

  const block = detail.locator(`[data-checklist-id="${checklist.id}"]`);
  const rows = block.locator(".checklist-item");
  await dragItem(page, rows.nth(0), rows.nth(2));
  await expect(rows.nth(2)).toContainText("Item 000");
  // Scroll the source tail beside the destination. Both connected lists retain their full
  // indices while containment is active.
  const last = rows.last();
  await last.scrollIntoViewIfNeeded();
  const target = detail.locator(`[data-checklist-id="${other.id}"] .checklist-item`).first();
  await target.scrollIntoViewIfNeeded();
  await dragItem(page, last, target);
  await expect(detail.locator(`[data-checklist-id="${other.id}"] .checklist-item`)).toHaveCount(2);

  // Measure through two animation frames without CPU throttling. The ceiling leaves headroom
  // above the measured 14–46ms baseline; keep the samples so regressions below it remain visible.
  const latency: number[] = [];
  const collapse = block.locator(".checklist-collapse");
  for (let index = 0; index < 8; index++) {
    await collapse.scrollIntoViewIfNeeded();
    latency.push(await collapse.evaluate(async (button) => {
      const start = performance.now();
      (button as HTMLElement).click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return performance.now() - start;
    }));
  }
  expect(Math.max(...latency), "local collapse/expand must remain below the measured regression ceiling").toBeLessThan(100);
  await page.waitForTimeout(300); // The 150ms persistence debounce must have settled before counting.
  await page.evaluate(() => { (window as typeof window & { detailWrites: number }).detailWrites = 0; });
  await json(await api.post(`/api/cards/${card.id}/checklists/${checklist.id}/items/batch`, {
    data: { items: Array.from({ length: 20 }, (_, index) => ({ text: `Burst ${index}` })) },
  }));
  await expect(block.locator(".checklist-item")).toHaveCount(169);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { detailWrites: number }).detailWrites)).toBe(1);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as typeof window & { detailWrites: number }).detailWrites)).toBe(1);
  // Accumulating older pages activates feed containment without dropping searchable content.
  await detail.locator(".feed-scroll-sentinel").scrollIntoViewIfNeeded();
  await expect(detail.locator(".large-feed")).toHaveCount(1);
  expect(await detail.locator(".attach-row").first().evaluate((element) => getComputedStyle(element).contentVisibility)).toBe("auto");
  await detail.locator(".col-comments").evaluate((element) => { element.scrollTop = 0; });
  // Refresh once for the edits, then validate the unchanged representation without downloading it.
  const refresh = async () => {
    const response = page.waitForResponse((response) => response.url().endsWith(`/cards/${card.id}/detail`));
    await page.locator("k-card-detail").evaluate((element) => {
      (window as typeof window & { ng: { getComponent: (element: Element) => { retryDetail: () => void } } }).ng.getComponent(element).retryDetail();
    });
    return response;
  };
  const refreshed = await refresh();
  expect(refreshed.status()).toBe(200);
  // Wait for the first read's promise/reconciliation to release its single-flight guard.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const unchanged = await refresh();
  expect(unchanged.status()).toBe(304);
  expect(unchanged.headers()["x-card-revision"]).toMatch(/^\d+$/);
  expect(unchanged.headers()["x-card-revision"]).toBe(refreshed.headers()["x-card-revision"]);
  await expect(block.locator(".checklist-item")).toHaveCount(169);
  await detail.locator(".col-main").evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath("large-card-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(detail.locator("k-card-detail-description > .detail-section")).toHaveCSS("flex", "0 0 auto");
  expect((await detail.locator("k-card-detail-description > .detail-section").boundingBox())!.height).toBeLessThan(120);
  await page.screenshot({ path: testInfo.outputPath("large-card-phone.png") });
  await testInfo.attach("interaction-latency.json", { body: JSON.stringify({ milliseconds: latency, openRequests, totalRequests: requests, checklistItems: 171, attachments: 55 }), contentType: "application/json" });
});

test("first-open revision race hydrates the latest cross-process edit without retrying detail", async ({ page, apiAs, signIn, testWorkspace, uniqueName }) => {
  const api = await apiAs("amelia");
  const card = await json<{ id: string; title: string }>(await api.post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")}/cards`, { data: { title: uniqueName("Revision race") } }));
  const checklist = await json<{ id: string; items: { id: string }[] }>(await api.post(`/api/cards/${card.id}/checklists`, { data: { title: "Race checklist", items: [{ text: "Before request" }] } }));
  const key = await json<{ id: string; secret: string }>(await api.post(`/api/workspaces/${testWorkspace.id}/api-keys`, { data: { name: uniqueName("Revision key"), scope: "write" } }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  let requests = 0;
  let responseRevision = "0";
  let eventRevision = "0";
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
    const frame = String(payload);
    if (frame.includes("card:checklistItem:updated") && frame.includes("After request")) {
      const revision = /"detailRevision":"(\d+)"/.exec(frame);
      if (revision) eventRevision = revision[1]!;
    }
  }));
  await page.route(`**/api/cards/${card.id}/detail`, async (route) => {
    requests++;
    const response = await route.fetch();
    responseRevision = ((await response.json()) as { revision: string }).revision;
    held = true;
    await gate;
    await route.fulfill({ response });
  });
  try {
    await signIn(page, "amelia", `/b/${testWorkspace.boardId}`);
    const opening = openCard(page, card.title);
    await expect.poll(() => held).toBe(true);
    const edited = await api.patch(`http://localhost:${ports.publicApi}/api/v1/cards/${card.id}/checklists/${checklist.id}/items/${checklist.items[0]!.id}`, {
      headers: { authorization: `Bearer ${key.secret}` }, data: { text: "After request" },
    });
    expect(edited.ok(), await edited.text()).toBe(true);
    await expect.poll(() => BigInt(eventRevision) > BigInt(responseRevision)).toBe(true);
    // Duplicate callers must keep the original journal, including this already-delivered edit.
    await page.locator("k-card-detail").evaluate((element) => {
      const component = (window as typeof window & { ng: { getComponent: (element: Element) => { retryDetail: () => void } } }).ng.getComponent(element);
      component.retryDetail();
      component.retryDetail();
    });
    release();
    const detail = await opening;
    await expect(detail.locator(".checklist-item-text")).toHaveText("After request");
    expect(requests).toBe(1);
  } finally {
    release();
    await api.delete(`/api/workspaces/${testWorkspace.id}/api-keys/${key.id}`);
  }
});
