import type { APIResponse } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { webOrigin } from "./support/env";
import { boardIdOf, expectBoardLoaded, openCard } from "./support/ui";

async function result<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

test("websocket compression follows configuration and delivers small and large public API updates", async ({ page, signIn, apiAs, playwright, uniqueName }, testInfo) => {
  const compressionEnabled = process.env.REALTIME_WEBSOCKET_COMPRESSION_ENABLED === "true";
  const extensions: string[] = [];
  const socketIds = new Set<string>();
  const received: { id: string; title: string; description?: string | null; bytes: number }[] = [];
  // Observe Chromium's real connection. routeWebSocket would terminate the browser transport at
  // Playwright and would not prove the browser negotiated the production compression settings.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.webSocketCreated", ({ requestId, url }) => {
    if (url.includes("/socket.io/")) socketIds.add(requestId);
  });
  cdp.on("Network.webSocketHandshakeResponseReceived", ({ requestId, response }) => {
    if (!socketIds.has(requestId)) return;
    extensions.push(Object.entries(response.headers).find(([name]) => name.toLowerCase() === "sec-websocket-extensions")?.[1] ?? "");
  });
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/socket.io/")) return;
    socket.on("framereceived", ({ payload }) => {
      const text = typeof payload === "string" ? payload : payload.toString("utf8");
      if (!text.startsWith('42["card:updated",')) return;
      const [, event] = JSON.parse(text.slice(2)) as [string, { card: { id: string; title: string; description?: string | null } }];
      received.push({ ...event.card, bytes: Buffer.byteLength(text) });
    });
  });

  await signIn(page, "amelia");
  // First prove a real handshake arrived: an empty capture must not pass the disabled-default test.
  await expect.poll(() => extensions.length).toBeGreaterThan(0);
  for (const value of extensions) {
    expect(value.includes("permessage-deflate")).toBe(compressionEnabled);
    // Opt-in compression must still honor the size threshold instead of compressing tiny events.
    if (compressionEnabled) expect(value).toContain("server_no_context_takeover");
  }
  const api = await apiAs("amelia");
  const seedBoard = await boardIdOf(page, "Platform Delivery");
  const context = await result<{ board: { workspaceId: string }; lists: { id: string }[] }>(await api.get(`/api/boards/${seedBoard}?includeCards=false`));
  const boardName = uniqueName("Compression delivery");
  const board = await result<{ id: string }>(await api.post(`/api/workspaces/${context.board.workspaceId}/boards`, { data: { name: boardName } }));
  let keyId: string | undefined;
  let publicApi: Awaited<ReturnType<typeof playwright.request.newContext>> | undefined;
  try {
    const key = await result<{ id: string; secret: string }>(await api.post("/api/me/api-keys", { data: { label: uniqueName("Compress key"), scope: "write" } }));
    keyId = key.id;
    publicApi = await playwright.request.newContext({ baseURL: webOrigin, extraHTTPHeaders: { authorization: `Bearer ${key.secret}` } });
    const title = uniqueName("Compression card");
    const card = await result<{ id: string }>(await api.post(`/api/boards/${board.id}/lists/${context.lists[0]!.id}/cards`, { data: { title } }));
    await page.goto(`/b/${board.id}`);
    await expectBoardLoaded(page, boardName);
    const detail = await openCard(page, title);

    for (const [index, description] of [null, "First independently compressed description. ".repeat(200), null, "Second independently compressed description. ".repeat(200)].entries()) {
      const nextTitle = `${title} update ${index}`;
      // Public API writes must pass through the durable outbox and real Valkey before Chromium
      // decodes them. Checking the full received body catches truncated/invalid compressed frames.
      await result(await publicApi.patch(`/public-api/api/v1/cards/${card.id}`, { data: { title: nextTitle, description } }));
      await expect.poll(() => received.filter(event => event.id === card.id).map(event => event.title)).toContain(nextTitle);
      const event = received.find(event => event.id === card.id && event.title === nextTitle)!;
      expect(event.description ?? null).toBe(description);
      if (description === null) expect(event.bytes).toBeLessThan(1024);
      else expect(event.bytes).toBeGreaterThan(1024);
      await expect(detail.locator("h2.card-title")).toHaveText(nextTitle);
      if (description) await expect(detail.locator(".description-viewer-wrap")).toContainText(description.trim());
    }
    expect(received.filter(event => event.id === card.id).map(event => event.title)).toEqual(Array.from({ length: 4 }, (_, i) => `${title} update ${i}`));
    await testInfo.attach("compression-delivery.json", { body: JSON.stringify({ compressionEnabled, extensions, received: received.filter(event => event.id === card.id) }, null, 2), contentType: "application/json" });
    await page.screenshot({ path: testInfo.outputPath("compressed-update.png"), fullPage: true });
  } finally {
    await publicApi?.dispose();
    if (keyId) {
      const revoked = await api.delete(`/api/me/api-keys/${keyId}`);
      expect(revoked.ok(), await revoked.text()).toBe(true);
    }
    const deleted = await api.delete(`/api/boards/${board.id}`);
    expect(deleted.ok(), await deleted.text()).toBe(true);
    await cdp.detach();
  }
});
