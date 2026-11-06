import type { APIResponse, Locator, Page } from "@playwright/test";
import { webOrigin } from "./support/env";
import { expect, test } from "./support/fixtures";
import { SocketLink } from "./support/socket";
import { cardTile, expectBoardLoaded, openCard } from "./support/ui";

// Optimistic writes and their settlement must never undo state the viewer has since received. Each
// test holds the viewer's own request at the browser boundary while a teammate's newer write lands
// over realtime, then releases it and checks the view against the durable API.

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

function tableRow(page: Page, cardId: string): Locator {
  return page.locator(`k-board-table-view .tv-row[data-card-id="${cardId}"]`);
}

async function showTable(page: Page, surface: "board" | "global work", boardId: string, boardName: string) {
  if (surface === "board") {
    await page.goto(`/b/${boardId}`);
    await expectBoardLoaded(page, boardName);
  } else {
    await page.goto("/my-cards");
  }
  await page.getByRole("button", { name: "Table view", exact: true }).click();
  await expect(page.getByRole("button", { name: "Table view", exact: true })).toHaveAttribute("aria-pressed", "true");
}

/**
 * Where the viewer moves the card from, and where its list is read back. The board's table groups
 * by list (no status cell), so the board moves through card detail and reads the tile's lane; Global
 * Work uses its table's status cell. Both reach the surface's one optimistic move path.
 */
async function openMoveSurface(page: Page, surface: "board" | "global work", boardId: string, boardName: string, card: { id: string; title: string }) {
  if (surface === "board") {
    await page.goto(`/b/${boardId}`);
    await expectBoardLoaded(page, boardName);
    const detail = await openCard(page, card.title);
    return {
      list: page.locator("k-list").filter({ has: cardTile(page, card.title) }).locator(".list-header h3"),
      moveTo: async (listName: string) => {
        await detail.locator(".move-list-btn:visible").first().click();
        await detail.locator(".move-list-popover .move-list-option").filter({ hasText: listName }).click();
      },
    };
  }
  await showTable(page, surface, boardId, boardName);
  const status = tableRow(page, card.id).locator('[data-col="status"]');
  return {
    list: status,
    moveTo: async (listName: string) => {
      await status.locator("button").click();
      await page.locator("k-anchored-picker .pl-row").filter({ hasText: listName }).click();
    },
  };
}

const OUTCOMES = [
  { name: "a move that fails does not undo a teammate's newer move", request: "fails", teammateMoves: true, settlesIn: "In Progress" },
  { name: "a move that succeeds late does not undo a teammate's newer move", request: "succeeds late", teammateMoves: true, settlesIn: "In Progress" },
  { name: "a move that fails with nothing newer returns the card to its list", request: "fails", teammateMoves: false, settlesIn: "Backlog" },
] as const;

for (const surface of ["board", "global work"] as const) {
  for (const outcome of OUTCOMES) {
    test(`on the ${surface}, ${outcome.name}`, async ({ page, testWorkspace, signIn, apiAs, runtimeGuard, uniqueName }, testInfo) => {
      const api = await apiAs("amelia");
      const teammate = await apiAs("marcus");
      const me = await json<{ id?: string; user?: { id: string } }>(await api.get("/api/me"));
      const title = uniqueName("Reconcile move");
      const card = await json<{ id: string }>(await api.post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")}/cards`, {
        data: { title, assigneeIds: [me.user?.id ?? me.id!] },
      }));
      await signIn(page, "amelia");
      const view = await openMoveSurface(page, surface, testWorkspace.boardId, testWorkspace.boardName, { id: card.id, title });
      const status = view.list;
      await expect(status).toContainText("Backlog");

      const captured = gate();
      const release = gate();
      await page.route(`**/api/cards/${card.id}/move`, async (route) => {
        // "succeeds late": the move commits now, but its response reaches the page only after the
        // teammate's newer move has. "fails": the request never reaches the server.
        const response = outcome.request === "succeeds late" ? await route.fetch() : null;
        captured.release();
        await release.promise;
        if (response) await route.fulfill({ response });
        else await route.fulfill({ status: 409, json: { message: "Move rejected" } });
      });
      await view.moveTo("Done");
      await expect(status).toContainText("Done");
      await captured.promise;

      if (outcome.teammateMoves) {
        await json(await teammate.post(`/api/cards/${card.id}/move`, { data: { listId: testWorkspace.lists.get("In Progress"), beforeCardId: null } }));
        await expect(status).toContainText("In Progress");
      }
      // Let Global Work's debounced background refresh (180ms) settle first, so nothing scheduled
      // after the release can mask a wrong settlement.
      await page.waitForTimeout(600);
      const settled = page.waitForResponse((response) => response.url().endsWith(`/cards/${card.id}/move`));
      release.release();
      await settled;
      await page.waitForTimeout(600);
      await expect(status).toContainText(outcome.settlesIn, { timeout: 1_000 });
      const server = await json<{ card: { listId: string } }>(await api.get(`/api/cards/${card.id}/detail`));
      expect(server.card.listId).toBe(testWorkspace.lists.get(outcome.settlesIn));
      if (outcome.request === "fails") {
        // A rejected move reaches the page as an unhandled rejection; expect exactly that one here,
        // so any other runtime problem still fails the test.
        const rejected = runtimeGuard.problems.filter((problem) => problem.includes("ApiError: api 409"));
        expect(rejected).toHaveLength(1);
        runtimeGuard.problems.splice(runtimeGuard.problems.indexOf(rejected[0]!), 1);
      }
      await page.screenshot({ path: testInfo.outputPath(`${surface.replace(" ", "-")}-${outcome.request.replace(" ", "-")}${outcome.teammateMoves ? "" : "-alone"}.png`) });
    });
  }
}

test("a disconnected board and Global Work converge on a public API edit after reconnecting", async ({ testWorkspace, pageAs, apiAs, playwright, uniqueName }, testInfo) => {
  const api = await apiAs("marcus");
  const me = await json<{ id?: string; user?: { id: string } }>(await api.get("/api/me"));
  const title = uniqueName("Reconnect public edit");
  const renamed = `${title} renamed`;
  const card = await json<{ id: string }>(await api.post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")}/cards`, {
    data: { title, assigneeIds: [me.user?.id ?? me.id!] },
  }));
  const key = await json<{ id: string; secret: string }>(await api.post("/api/me/api-keys", { data: { label: uniqueName("Reconnect key"), scope: "write" } }));
  const publicApi = await playwright.request.newContext({ baseURL: webOrigin, extraHTTPHeaders: { authorization: `Bearer ${key.secret}` } });
  try {
    let link!: SocketLink;
    const board = await pageAs("marcus", { beforeSignIn: async (context) => { link = await SocketLink.install(context); } });
    const work = await board.context().newPage();
    await showTable(board, "board", testWorkspace.boardId, testWorkspace.boardName);
    await showTable(work, "global work", testWorkspace.boardId, testWorkspace.boardName);
    for (const page of [board, work]) await expect(tableRow(page, card.id).locator('[data-col="title"]')).toContainText(title);

    await link.cut();
    await expect.poll(() => link.refusedAttempts).toBeGreaterThan(0);
    await json(await publicApi.patch(`/public-api/api/v1/cards/${card.id}`, { data: { title: renamed } }));
    // Bounded negative check: live delivery lands well inside this window, so seeing the rename
    // here would mean the cut leaked and the rest of the test proves nothing.
    await board.waitForTimeout(3_000);
    for (const page of [board, work]) await expect(tableRow(page, card.id).locator('[data-col="title"]')).not.toContainText("renamed");

    link.restore();
    // Socket.IO connection-state recovery is off, so the missed card:updated is gone; both views
    // converge only by refetching after they rejoin their rooms.
    for (const page of [board, work]) await expect(tableRow(page, card.id).locator('[data-col="title"]')).toContainText(renamed);
    await work.screenshot({ path: testInfo.outputPath("global-work-reconnected.png") });
  } finally {
    await publicApi.dispose();
    expect((await api.delete(`/api/me/api-keys/${key.id}`)).ok()).toBe(true);
  }
});
