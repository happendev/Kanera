import { expect, test } from "./support/scenario";
import { SocketLink } from "./support/socket";
import { cardTile, createCard, expectBoardLoaded, expectCardTileMounted, openBoard, openCard } from "./support/ui";

test("a disconnected board converges on the latest card after its socket reconnects", async ({ page, signIn, pageAs, uniqueName }) => {
  const original = uniqueName("E2E reconnect card");
  const updated = `${original} updated`;
  let link!: SocketLink;
  await signIn(page, "amelia");
  const second = await pageAs("marcus", {
    beforeSignIn: async (context) => {
      link = await SocketLink.install(context);
    },
  });
  await openBoard(page, "E2E primary board");
  await openBoard(second, "E2E primary board");

  await createCard(page, original);
  await expectCardTileMounted(second, original);

  await link.cut();
  // Proves the cut is real: the client noticed and its reconnect attempts are being refused.
  await expect.poll(() => link.refusedAttempts).toBeGreaterThan(0);

  const detail = await openCard(page, original);
  await detail.locator("h2.card-title").click();
  await detail.locator("input.title-input").fill(updated);
  await detail.locator("input.title-input").press("Enter");
  await expect(page.getByRole("dialog", { name: `Card detail: ${updated}` })).toBeVisible();
  // Bounded negative check: live delivery normally lands well inside this window, so seeing the
  // rename here would mean the cut leaked and the rest of the test proves nothing.
  await second.waitForTimeout(3_000);
  await expect(cardTile(second, updated)).toHaveCount(0);

  link.restore();
  // The server does not enable Socket.IO connection-state recovery, so the missed card:updated is
  // gone; the board converges only if it resyncs after rejoining its room (board:join -> onJoined).
  await expectCardTileMounted(second, updated);
  await expect(cardTile(second, original).filter({ hasNotText: "updated" })).toHaveCount(0);
  await second.reload();
  await expectBoardLoaded(second, "E2E primary board");
  // A reload resets the lane's render window, so mount the tile again before counting it.
  await expectCardTileMounted(second, updated);
});

test("brief board tab switches avoid refetches but long absences recover agent runs", async ({ page, signIn }, testInfo) => {
  let agentRequests = 0;
  let boardRequests = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/boards\/[^/]+\/agent-runs$/.test(path)) agentRequests++;
    if (/\/boards\/[^/]+\/open$/.test(path)) boardRequests++;
  });
  await signIn(page, "amelia");
  await openBoard(page, "E2E primary board");
  await expect.poll(() => agentRequests).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  const initialAgents = agentRequests;
  const initialBoards = boardRequests;
  const visibility = async (state: "hidden" | "visible") => {
    await page.evaluate((value) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value });
      document.dispatchEvent(new Event("visibilitychange"));
    }, state);
  };
  await visibility("hidden");
  await visibility("visible");
  // A bounded negative check catches an accidental unconditional visibility refresh.
  await page.waitForTimeout(1_000);
  expect(agentRequests).toBe(initialAgents);
  expect(boardRequests).toBe(initialBoards);

  await page.clock.setFixedTime(new Date());
  await visibility("hidden");
  await page.clock.setFixedTime(new Date(Date.now() + 61_000));
  await visibility("visible");
  await expect.poll(() => agentRequests).toBeGreaterThan(initialAgents);
  await expect.poll(() => boardRequests).toBeGreaterThan(initialBoards);
  await expectBoardLoaded(page, "E2E primary board");
  await page.screenshot({ path: testInfo.outputPath("board-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("board-phone.png") });
});

test("agent badges update over the socket and recover missed endings after reconnect", async ({ page, context, signIn, apiAs, testWorkspace, uniqueName }) => {
  const link = await SocketLink.install(context);
  const api = await apiAs("amelia");
  const title = uniqueName("Agent recovery");
  const created = await api.post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")!}/cards`, { data: { title } });
  expect(created.ok()).toBeTruthy();
  const card = await created.json() as { id: string };
  await signIn(page, "amelia");
  await openBoard(page, "E2E primary board");
  const badge = cardTile(page, title).locator(".card-agent-run");
  await expect(badge).toHaveCount(0);
  const started = await api.post(`/api/cards/${card.id}/agent-runs`, { data: { title: "Working" } });
  expect(started.ok()).toBeTruthy();
  const run = await started.json() as { id: string };
  await expect(badge).toBeVisible();
  const blocked = await api.patch(`/api/agent-runs/${run.id}`, { data: { status: "blocked" } });
  expect(blocked.ok()).toBeTruthy();
  await expect(badge).toHaveClass(/is-blocked/);
  await link.cut();
  await expect.poll(() => link.refusedAttempts).toBeGreaterThan(0);
  const ended = await api.patch(`/api/agent-runs/${run.id}`, { data: { status: "succeeded" } });
  expect(ended.ok()).toBeTruthy();
  await page.waitForTimeout(1_000);
  await expect(badge).toBeVisible();
  link.restore();
  await expect(badge).toHaveCount(0);
});
