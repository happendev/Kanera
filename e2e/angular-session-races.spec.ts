import type { APIResponse, Page, WebSocketRoute } from "@playwright/test";
import { SEED_PASSWORD, users, type SeedUser } from "./support/env";
import { expect, test } from "./support/fixtures";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function result<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

async function logout(page: Page, user: SeedUser) {
  await page.getByRole("button", { name: users[user].name, exact: true }).click();
  const response = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/auth/logout");
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await response;
  await expect(page).toHaveURL(/\/login/);
}

async function loginInSameDocument(page: Page, user: SeedUser) {
  // A full navigation would recreate root services and hide these lifecycle failures, so this
  // regression intentionally uses the form for the second session in the existing document.
  await page.locator("#email").fill(users[user].email);
  await page.locator("#password").fill(SEED_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("k-app-shell")).toBeVisible();
  await expect(page.getByRole("button", { name: users[user].name, exact: true })).toBeVisible();
}

test("logout clears private root state before another account signs in", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const owner = await apiAs("amelia");
  const guest = await apiAs("maya");
  const firstUser = await result<{ id: string }>(await owner.get("/api/me"));
  const nextUser = await result<{ id: string }>(await guest.get("/api/me"));
  const title = uniqueName("Private outgoing priority");
  const workspace = await result<{ id: string; initialBoard: { id: string } }>(await owner.post("/api/workspaces", {
    data: { name: uniqueName("Private session workspace"), initialBoard: { name: uniqueName("Private session board") } },
  }));
  const board = await result<{ lists: { id: string }[] }>(await owner.get(`/api/boards/${workspace.initialBoard.id}?includeCards=false`));
  const card = await result<{ id: string }>(await owner.post(`/api/boards/${workspace.initialBoard.id}/lists/${board.lists[0]!.id}/cards`, {
    data: { title, assigneeIds: [firstUser.id] },
  }));
  await result(await owner.post(`/api/work/priorities/${firstUser.id}/cards`, { data: { cardId: card.id, beforeId: null } }));
  const release = deferred();
  let nextQueueRequests = 0;
  try {
    await signIn(page, "amelia");
    await expect(page.locator("k-home k-priority-queue")).toContainText(title);
    await logout(page, "amelia");
    await page.route(`**/api/work/priorities/${nextUser.id}`, async (route) => {
      nextQueueRequests += 1;
      await release.promise;
      await route.continue();
    });
    await loginInSameDocument(page, "maya");
    await expect.poll(() => nextQueueRequests, { message: "the new session initializes its own priority queue" }).toBeGreaterThan(0);
    await expect(page.locator("k-app-shell")).not.toContainText(title);
    await page.screenshot({ path: testInfo.outputPath("new-session-private-state-cleared.png"), fullPage: true });
    release.resolve();
    await expect(page.locator("k-app-shell")).not.toContainText(title);
  } finally {
    release.resolve();
    await owner.delete(`/api/workspaces/${workspace.id}`);
  }
});

test("a delayed session reload cannot restore credentials after logout", async ({ page, context, signIn, apiAs }, testInfo) => {
  let socket: WebSocketRoute | undefined;
  await context.routeWebSocket(/\/socket\.io\//, (ws) => { socket = ws; ws.connectToServer(); });
  await signIn(page, "amelia");
  await expect(page.getByRole("button", { name: users.amelia.name, exact: true })).toBeVisible();
  const owner = await apiAs("amelia");
  const user = await result<{ clientId: string }>(await owner.get("/api/me"));
  const received = deferred();
  const release = deferred();
  const delivered = deferred();
  await page.route("**/api/me", async (route) => {
    const response = await route.fetch();
    received.resolve();
    await release.promise;
    await route.fulfill({ response });
    delivered.resolve();
  });
  try {
    await expect.poll(() => Boolean(socket)).toBe(true);
    // Exercise the same reload path as a server entitlement change. Delay the real /me response,
    // not the browser thread, so the user can finish logging out while the old read is pending.
    socket!.send(`42${JSON.stringify(["client:entitlements:changed", { clientId: user.clientId }])}`);
    await received.promise;
    await logout(page, "amelia");
    // Forgot password uses Angular routing; the signup link performs a full document navigation
    // that would destroy AuthService and hide this stale-response regression.
    await page.getByRole("link", { name: "Forgot password?", exact: true }).click();
    await expect(page).toHaveURL(/\/forgot-password/);
    release.resolve();
    await delivered.promise;
    await expect.poll(() => page.evaluate(() => localStorage.getItem("kanera:offline-identity"))).toBeNull();
    // The abandoned reload must also leave later public navigation alone.
    await expect(page).toHaveURL(/\/forgot-password/);
    await expect(page.locator("k-app-shell")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("late-session-response-stays-signed-out.png"), fullPage: true });
  } finally {
    release.resolve();
  }
});

test("appearance realtime subscriptions work after logout and same-document login", async ({ page, signIn, apiAs }, testInfo) => {
  const owner = await apiAs("amelia");
  const original = await result<{ theme: string | null; accent: string | null }>(await owner.get("/api/me"));
  let connectedNamespaces = 0;
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
    if (String(payload).startsWith("40")) connectedNamespaces += 1;
  }));
  try {
    await result(await owner.patch("/api/auth/me", { data: { theme: "light", accent: "default" } }));
    await signIn(page, "amelia");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect.poll(() => connectedNamespaces).toBeGreaterThan(0);
    await logout(page, "amelia");
    const previousConnections = connectedNamespaces;
    await loginInSameDocument(page, "amelia");
    await expect.poll(() => connectedNamespaces).toBeGreaterThan(previousConnections);
    await result(await owner.patch("/api/auth/me", { data: { theme: "dark" } }));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: testInfo.outputPath("second-session-live-appearance.png"), fullPage: true });
  } finally {
    await owner.patch("/api/auth/me", { data: { theme: original.theme, accent: original.accent } });
  }
});
