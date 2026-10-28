import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./support/scenario";
import { boardIdOf, cardTile, completeCard, expectCardTileMounted, openBoard, openCard } from "./support/ui";

// Card dependencies across boards of one workspace. The blocker lives on E2E secondary board and the
// blocked card on E2E primary board, so the viewer's badge can only change through the
// dependents fanout (`card:updated` with `blockedByCount` on the *dependent's* board), never
// through an event the blocker's own board room carries. Nothing here reloads.

type CreatedCard = { id: string; key: string; title: string };

async function createCardOnBoard(page: Page, api: APIRequestContext, boardName: string, title: string): Promise<CreatedCard> {
  const boardId = await boardIdOf(page, boardName);
  const board = await api.get(`/api/boards/${boardId}?includeCards=false`);
  const { lists } = (await board.json()) as { lists: { id: string; name: string }[] };
  const backlog = lists.find((list) => list.name === "Backlog") ?? lists[0]!;
  const created = await api.post(`/api/boards/${boardId}/lists/${backlog.id}/cards`, { data: { title, atTop: true } });
  expect(created.ok(), await created.text()).toBe(true);
  return (await created.json()) as CreatedCard;
}

test("a dependency added in card detail blocks a card on another board until its blocker completes, live", async ({ page, signIn, pageAs, apiAs, uniqueName }) => {
  await signIn(page, "amelia");
  await openBoard(page, "E2E primary board");
  const api = await apiAs("amelia");
  const blocked = await createCardOnBoard(page, api, "E2E primary board", uniqueName("E2E blocked launch"));
  const boardMeta = await (await api.get(`/api/boards/${await boardIdOf(page, "E2E primary board")}?includeCards=false`)).json() as { board: { workspaceId: string } };
  const keyResponse = await api.post(`/api/workspaces/${boardMeta.board.workspaceId}/api-keys`, { data: { name: uniqueName("Deps key"), scope: "write" } });
  expect(keyResponse.status(), await keyResponse.text()).toBe(201);
  const key = await keyResponse.json() as { id: string; secret: string };
  const blocker = await createCardOnBoard(page, api, "E2E secondary board", uniqueName("E2E blocking migration"));
  let label: { id: string } | null = null;

  try {
    // A second member watches the blocked card's board and has been told nothing.
    const viewer = await pageAs("marcus");
    await openBoard(viewer, "E2E primary board");
    await expectCardTileMounted(viewer, blocked.title);
    const viewerTile = cardTile(viewer, blocked.title);
    await expect(viewerTile.locator(".card-blocked")).toHaveCount(0);

    // Amelia records the dependency as a person would: search the blocker by key in card detail.
    await expectCardTileMounted(page, blocked.title);
    const detail = await openCard(page, blocked.title);
    const dependencies = detail.locator("k-card-relations");
    await dependencies.getByRole("button", { name: "Add", exact: true }).click();
    await dependencies.getByRole("button", { name: "Blocked by", exact: true }).click();
    await dependencies.getByRole("searchbox", { name: "Search cards by title or key" }).fill(blocker.title);
    const added = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/cards/${blocked.id}/relations`));
    await dependencies.getByRole("option").filter({ hasText: blocker.key }).click();
    expect((await added).status()).toBe(201);
    await expect(dependencies.locator(".cr-group").filter({ hasText: "Blocked by" }).getByText(blocker.title)).toBeVisible();
    // The status lives in the header chip row (beside time in progress), not inside the section.
    await expect(detail.getByRole("button", { name: /Blocked by 1 active card/ })).toBeVisible();

    // The viewer's tile picks up the chip from realtime alone.
    await expect(viewerTile.locator(".card-blocked")).toBeVisible();
    await expect(viewerTile.locator(".card-blocked")).toHaveText("Blocked");
    await viewerTile.scrollIntoViewIfNeeded();
    await viewer.screenshot({ path: test.info().outputPath("blocked-tile-desktop.png") });

    // A cycle is refused with the server's own message, and nothing is stored.
    const cycle = await api.post(`/api/cards/${blocker.id}/relations`, { data: { targetCardId: blocked.id, direction: "blocked_by" } });
    expect(cycle.status()).toBe(400);

    // Keep the dependent drawer open: the tile and relationship snapshot must both converge.
    const liveDetail = await openCard(viewer, blocked.title);
    await expect(liveDetail.getByRole("button", { name: /Blocked by 1 active card/ })).toBeVisible();
    // Completing the blocker on the *other* board clears the badge on this one, without a reload.
    await page.keyboard.press("Escape");
    await openBoard(page, "E2E secondary board");
    await expectCardTileMounted(page, blocker.title);
    const completed = await api.patch(`/public-api/api/v1/cards/${blocker.id}/completion`, {
      headers: { authorization: `Bearer ${key.secret}` }, data: { completed: true },
    });
    expect(completed.ok(), await completed.text()).toBe(true);
    await expect(viewerTile.locator(".card-blocked")).toHaveCount(0);
    await expect(liveDetail.getByRole("button", { name: /No active blockers/ })).toBeVisible();
    await expect(liveDetail.locator("k-card-relations .cr-row.is-closed")).toContainText("Completed");
    await viewer.keyboard.press("Escape");
    // The blocked card's own detail now says it has no active blockers.
    await page.keyboard.press("Escape");
    await openBoard(page, "E2E primary board");
    const doneDetail = await openCard(page, blocked.title);
    await expect(doneDetail.getByRole("button", { name: /No active blockers/ })).toBeVisible();
    await expect(doneDetail.locator("k-card-relations .cr-row.is-closed")).toContainText("Completed");
    await page.keyboard.press("Escape");

    // Reopening it blocks again: the fanout runs in both directions.
    const reopened = await api.patch(`/api/cards/${blocker.id}/completion`, { data: { completed: false } });
    expect(reopened.ok()).toBe(true);
    await expect(viewerTile.locator(".card-blocked")).toBeVisible();

    // The viewer's open detail lists the blocker and drops it live when it is removed.
    const viewerDetail = await openCard(viewer, blocked.title);
    const viewerDependencies = viewerDetail.locator("k-card-relations");
    await expect(viewerDependencies.getByText(blocker.title)).toBeVisible();
    // A label put on the blocker shows here, and renaming that label (a catalogue change, not a
    // card change) updates the name shown without reopening the card.
    // Label names are capped at 25 characters, so both names stay short.
    const labelName = uniqueName("Dep");
    const renamedLabel = uniqueName("Renamed");
    const labelResponse = await api.post(`/api/workspaces/${boardMeta.board.workspaceId}/card-labels`, { data: { name: labelName } });
    expect(labelResponse.ok(), await labelResponse.text()).toBe(true);
    label = await labelResponse.json() as { id: string };
    expect((await api.put(`/api/cards/${blocker.id}/labels`, { data: { labelIds: [label.id] } })).ok()).toBe(true);
    await expect(viewerDependencies.getByText(labelName)).toBeVisible();
    expect((await api.patch(`/api/card-labels/${label.id}`, { data: { name: renamedLabel } })).ok()).toBe(true);
    await expect(viewerDependencies.getByText(renamedLabel)).toBeVisible();
    for (const [size, width] of [["desktop", 1280], ["phone", 390]] as const) {
      await viewer.setViewportSize({ width, height: 900 });
      await viewerDependencies.scrollIntoViewIfNeeded();
      await viewer.screenshot({ path: test.info().outputPath(`dependencies-detail-${size}.png`) });
    }
    await viewer.setViewportSize({ width: 1280, height: 900 });
    const relations = await (await api.get(`/api/cards/${blocked.id}/relations`)).json() as { relations: { id: string }[] };
    expect((await api.delete(`/api/cards/${blocked.id}/relations/${relations.relations[0]!.id}`)).status()).toBe(204);
    await expect(viewerDependencies.getByText(blocker.title)).toHaveCount(0);
    await viewer.keyboard.press("Escape");
    await expect(viewerTile.locator(".card-blocked")).toHaveCount(0);
  } finally {
    await api.delete(`/api/workspaces/${boardMeta.board.workspaceId}/api-keys/${key.id}`);
    if (label) await api.delete(`/api/card-labels/${label.id}`);
    for (const card of [blocked, blocker]) {
      expect((await api.patch(`/api/cards/${card.id}/archive`, { data: { archived: true } })).ok()).toBe(true);
    }
  }
});

test("the board and table right-click menus set dependencies, and the blocked card's watcher is told live", async ({ page, signIn, pageAs, apiAs, uniqueName }) => {
  await signIn(page, "amelia");
  await openBoard(page, "E2E primary board");
  const api = await apiAs("amelia");
  const blocked = await createCardOnBoard(page, api, "E2E primary board", uniqueName("E2E menu blocked"));
  const blocker = await createCardOnBoard(page, api, "E2E primary board", uniqueName("E2E menu blocker"));
  const related = await createCardOnBoard(page, api, "E2E primary board", uniqueName("E2E menu related"));
  // A label on the blocker, so its dependency row shows what kind of work it is.
  const { board } = (await (await api.get(`/api/boards/${await boardIdOf(page, "E2E primary board")}?includeCards=false`)).json()) as { board: { workspaceId: string } };
  const labelCreated = await api.post(`/api/workspaces/${board.workspaceId}/card-labels`, { data: { name: uniqueName("E2E dep label"), color: "purple" } });
  expect(labelCreated.ok(), await labelCreated.text()).toBe(true);
  const label = (await labelCreated.json()) as { id: string; name: string };
  expect((await api.put(`/api/cards/${blocker.id}/labels`, { data: { labelIds: [label.id] } })).ok()).toBe(true);

  try {
    // Marcus watches the card that is about to be blocked, and has his inbox open.
    const marcusApi = await apiAs("marcus");
    expect((await marcusApi.put(`/api/cards/${blocked.id}/watch`, { data: { watching: true } })).ok()).toBe(true);
    const watcher = await pageAs("marcus");
    await openBoard(watcher, "E2E primary board");
    await watcher.getByRole("button", { name: /^Notifications/ }).click();

    // Board tile: right-click → Dependencies… → Blocked by → pick the blocker.
    await expectCardTileMounted(page, blocked.title);
    await cardTile(page, blocked.title).click({ button: "right" });
    await page.getByRole("button", { name: "Dependencies…" }).click();
    const popover = page.getByRole("dialog", { name: "Dependencies" });
    // A card with no relations opens straight onto the search.
    await popover.getByRole("button", { name: "Blocked by", exact: true }).click();
    await popover.getByRole("searchbox", { name: "Search cards by title or key" }).fill(blocker.title);
    await popover.getByRole("option").filter({ hasText: blocker.key }).click();
    await expect(popover.locator(".cr-group").filter({ hasText: "Blocked by" }).getByText(blocker.title)).toBeVisible();
    await expect(popover.locator(".cr-row").filter({ hasText: blocker.title }).locator(".cr-labels")).toContainText(label.name);
    await expect(popover.locator(".cr-status.is-blocked")).toHaveText(/Blocked by 1 active card/);
    await page.screenshot({ path: test.info().outputPath("dependencies-menu-board.png") });
    await page.keyboard.press("Escape");
    await expect(cardTile(page, blocked.title).locator(".card-blocked")).toBeVisible();
    // No card detail was opened to do it.
    await expect(page.locator("k-card-detail .panel")).toHaveCount(0);

    const notification = watcher.locator(".notif-item").filter({ hasText: blocked.title });
    await expect(notification).toBeVisible();
    await expect(notification).toContainText("marked this card as blocked by");
    await expect(notification).toContainText(blocker.key);
    await watcher.screenshot({ path: test.info().outputPath("dependency-notification.png") });

    // Table row: the same menu, here adding a "Relates to".
    await page.getByRole("button", { name: "Table view", exact: true }).click();
    const row = page.locator("k-board-table-view .tv-row").filter({ hasText: blocked.title });
    await row.click({ button: "right" });
    await page.getByRole("button", { name: "Dependencies…" }).click();
    const tablePopover = page.getByRole("dialog", { name: "Dependencies" });
    await expect(tablePopover.getByText(blocker.title)).toBeVisible();
    // The popover is always on the search: there is no Add step.
    await expect(tablePopover.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
    await tablePopover.getByRole("button", { name: "Relates to", exact: true }).click();
    await tablePopover.getByRole("searchbox", { name: "Search cards by title or key" }).fill(related.title);
    await tablePopover.getByRole("option").filter({ hasText: related.key }).click();
    await expect(tablePopover.locator(".cr-group").filter({ hasText: "Related" }).getByText(related.title)).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("dependencies-menu-table.png") });
    // Keep the popover open while another request archives the blocker. Archived is inactive,
    // but must never be presented as completed; restoring it brings the blocking state back.
    expect((await api.patch(`/api/cards/${blocker.id}/archive`, { data: { archived: true } })).ok()).toBe(true);
    await expect(tablePopover.locator(".cr-status")).toHaveText(/No active blockers/);
    const blockerRow = tablePopover.locator(".cr-row").filter({ hasText: blocker.title });
    await expect(blockerRow).toContainText("Archived");
    await expect(blockerRow).not.toContainText("Completed");
    expect((await api.patch(`/api/cards/${blocker.id}/archive`, { data: { archived: false } })).ok()).toBe(true);
    await expect(tablePopover.locator(".cr-status")).toHaveText(/Blocked by 1 active card/);
    await expect(blockerRow).not.toContainText("Archived");
    await page.keyboard.press("Escape");

    // Team overview shows the same Blocked chip on the assignee's row.
    const me = (await (await marcusApi.get("/api/me")).json()) as { id?: string; user?: { id: string } };
    const marcusId = me.user?.id ?? me.id!;
    expect((await api.put(`/api/cards/${blocked.id}/assignees`, { data: { userIds: [marcusId] } })).ok()).toBe(true);
    await page.goto("/team-cards");
    await page.getByRole("button", { name: "Team overview" }).click();
    await page.getByRole("searchbox", { name: "Search cards" }).fill(blocked.title);
    const overviewRow = page.locator("button.row").filter({ has: page.locator(".row-title", { hasText: blocked.title }) }).first();
    await expect(overviewRow.locator(".row-blocked")).toHaveText("Blocked");
    await overviewRow.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("team-overview-blocked.png") });

    const relations = await (await api.get(`/api/cards/${blocked.id}/relations`)).json() as { relations: { direction: string; card: { id: string } }[] };
    expect(relations.relations.map((relation) => `${relation.direction}:${relation.card.id}`).sort()).toEqual([`blocked_by:${blocker.id}`, `relates_to:${related.id}`].sort());
  } finally {
    for (const card of [blocked, blocker, related]) {
      expect((await api.patch(`/api/cards/${card.id}/archive`, { data: { archived: true } })).ok()).toBe(true);
    }
    expect((await api.delete(`/api/card-labels/${label.id}`)).ok()).toBe(true);
  }
});

test("completing a card's last blocker hands it to its assignee live: inbox entry and card activity", async ({ page, signIn, pageAs, apiAs, uniqueName }) => {
  await signIn(page, "amelia");
  await openBoard(page, "E2E primary board");
  const api = await apiAs("amelia");
  const waiting = await createCardOnBoard(page, api, "E2E primary board", uniqueName("E2E handoff waiting"));
  const first = await createCardOnBoard(page, api, "E2E primary board", uniqueName("E2E handoff first"));
  const last = await createCardOnBoard(page, api, "E2E secondary board", uniqueName("E2E handoff last"));

  try {
    const marcusApi = await apiAs("marcus");
    const me = (await (await marcusApi.get("/api/me")).json()) as { id?: string; user?: { id: string } };
    expect((await api.put(`/api/cards/${waiting.id}/assignees`, { data: { userIds: [me.user?.id ?? me.id!] } })).ok()).toBe(true);
    for (const blocker of [first, last]) {
      const added = await api.post(`/api/cards/${waiting.id}/relations`, { data: { targetCardId: blocker.id, direction: "blocked_by" } });
      expect(added.status(), await added.text()).toBe(201);
    }

    // Marcus, the assignee, has his inbox open on another board.
    const assignee = await pageAs("marcus");
    await openBoard(assignee, "E2E primary board");
    await assignee.getByRole("button", { name: /^Notifications/ }).click();
    const handoff = assignee.locator(".notif-item").filter({ hasText: "cleared the last blocker on this card" }).filter({ hasText: waiting.title });

    // One blocker done, one still open: no handoff yet.
    expect((await api.patch(`/api/cards/${first.id}/completion`, { data: { completed: true } })).ok()).toBe(true);
    // Amelia closes the last one by hand, from its own board.
    await openBoard(page, "E2E secondary board");
    await expectCardTileMounted(page, last.title);
    await completeCard(await openCard(page, last.title));

    await expect(handoff).toBeVisible();
    await expect(handoff).toContainText(last.key);
    await expect(handoff).toHaveCount(1);
    await assignee.screenshot({ path: test.info().outputPath("handoff-notification.png") });

    // The waiting card's own feed records who cleared it and with which card.
    await assignee.keyboard.press("Escape");
    await expectCardTileMounted(assignee, waiting.title);
    const detail = await openCard(assignee, waiting.title);
    await expect(detail.getByText(`cleared the last blocker on this card, ${last.key}`)).toBeVisible();
    await expect(detail.locator("k-card-relations .cr-status.is-blocked")).toHaveCount(0);
    await assignee.screenshot({ path: test.info().outputPath("handoff-card-activity.png") });
  } finally {
    for (const card of [waiting, first, last]) {
      expect((await api.patch(`/api/cards/${card.id}/archive`, { data: { archived: true } })).ok()).toBe(true);
    }
  }
});


test("blocked completion is optional and removing the final blocker runs the handoff with history on both cards", async ({ page, signIn, apiAs, uniqueName }) => {
  await signIn(page, "amelia");
  await openBoard(page, "E2E primary board");
  const api = await apiAs("amelia");
  const blocked = await createCardOnBoard(page, api, "E2E primary board", uniqueName("Warning waiting"));
  const blocker = await createCardOnBoard(page, api, "E2E primary board", uniqueName("Warning blocker"));
  const meta = await (await api.get(`/api/boards/${await boardIdOf(page, "E2E primary board")}?includeCards=false`)).json() as { board: { workspaceId: string } };
  const workspaceId = meta.board.workspaceId;
  const relationResponse = await api.post(`/api/cards/${blocked.id}/relations`, { data: { targetCardId: blocker.id, direction: "blocked_by" } });
  expect(relationResponse.status()).toBe(201);
  const relation = await relationResponse.json() as { id: string };
  const comment = uniqueName("Ready handoff");
  const automationResponse = await api.post(`/api/workspaces/${workspaceId}/automations`, { data: {
    enabled: true, triggerType: "card_unblocked", actions: [{ type: "post_comment", config: { template: comment } }],
  } });
  expect(automationResponse.status()).toBe(201);
  const automation = await automationResponse.json() as { id: string };
  try {
    const detail = await openCard(page, blocked.title);
    await detail.getByRole("button", { name: "Mark complete", exact: true }).click();
    const warning = page.getByRole("dialog", { name: "Complete blocked work?" });
    await expect(warning).toBeVisible();
    for (const [label, width] of [["desktop", 1280], ["phone", 390]] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: test.info().outputPath(`blocked-completion-${label}.png`), animations: "disabled" });
    }
    await warning.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(detail.getByRole("button", { name: "Mark complete", exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "Mark complete", exact: true }).click();
    await warning.getByRole("checkbox", { name: "Don't warn again this session" }).check();
    await warning.getByRole("button", { name: "Complete anyway", exact: true }).click();
    await expect(detail.getByRole("button", { name: "Mark incomplete", exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "Mark incomplete", exact: true }).click();
    await completeCard(detail);
    await expect(warning).toHaveCount(0);
    await detail.getByRole("button", { name: "Mark incomplete", exact: true }).click();
    await expect(detail.getByRole("button", { name: "Mark complete", exact: true })).toBeVisible();
    expect((await api.delete(`/api/cards/${blocked.id}/relations/${relation.id}`)).status()).toBe(204);
    await expect(detail.locator("k-card-relations .cr-row")).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 900 });
    await detail.getByRole("button", { name: "Activity", exact: false }).click();
    await expect(detail.getByText(comment, { exact: true })).toBeVisible();
    for (const id of [blocked.id, blocker.id]) {
      const feed = await (await api.get(`/api/cards/${id}/feed?limit=100`)).json() as { items: { type: string; data: { action?: string; content?: string } }[] };
      expect(feed.items.some((item) => item.data.action === "relation:removed")).toBe(true);
    }
  } finally {
    await api.delete(`/api/workspaces/${workspaceId}/automations/${automation.id}`);
    for (const card of [blocked, blocker]) await api.patch(`/api/cards/${card.id}/archive`, { data: { archived: true } });
  }
});

test("dependency search excludes existing links before limiting results and refreshes when the direction changes", async ({ page, signIn, apiAs, uniqueName }) => {
  await signIn(page, "amelia");
  await openBoard(page, "E2E primary board");
  const api = await apiAs("amelia");
  const blocked = await createCardOnBoard(page, api, "E2E primary board", uniqueName("Search owner"));
  const query = uniqueName("Dependency candidate");
  const candidates: CreatedCard[] = [];
  try {
    for (let i = 0; i < 12; i++) {
      const card = await createCardOnBoard(page, api, "E2E primary board", `${query} ${query} ${i}`);
      candidates.push(card);
      expect((await api.post(`/api/cards/${blocked.id}/relations`, { data: { targetCardId: card.id, direction: "blocked_by" } })).ok()).toBe(true);
    }
    // More relevant hits in another workspace must not consume the current workspace's limit.
    const foreignResponse = await api.post("/api/workspaces", { data: {
      name: uniqueName("Dependency search other workspace"), initialBoard: { name: uniqueName("Foreign candidates") },
      lists: [{ name: "Backlog" }, { name: "Done" }], customFields: [], labels: [],
    } });
    expect(foreignResponse.ok(), await foreignResponse.text()).toBe(true);
    const foreign = await foreignResponse.json() as { initialBoard: { id: string } };
    const foreignBoard = await api.get(`/api/boards/${foreign.initialBoard.id}?includeCards=false`);
    expect(foreignBoard.ok(), await foreignBoard.text()).toBe(true);
    const { lists } = await foreignBoard.json() as { lists: { id: string }[] };
    for (let i = 0; i < 2; i++) {
      const created = await api.post(`/api/boards/${foreign.initialBoard.id}/lists/${lists[0]!.id}/cards`, {
        data: { title: `${query} ${query} ${query} foreign ${i}` },
      });
      expect(created.ok(), await created.text()).toBe(true);
      candidates.push(await created.json() as CreatedCard);
    }
    const eligible = await createCardOnBoard(page, api, "E2E primary board", `${query} eligible`);
    candidates.push(eligible);
    await expectCardTileMounted(page, blocked.title);
    const detail = await openCard(page, blocked.title);
    const dependencies = detail.locator("k-card-relations");
    await dependencies.getByRole("button", { name: "Add", exact: true }).click();
    await dependencies.getByRole("searchbox").fill(query);
    await expect(dependencies.getByRole("option")).toHaveCount(1);
    await expect(dependencies.getByRole("option")).toContainText(eligible.key);
    await dependencies.getByRole("button", { name: "Relates to", exact: true }).click();
    await expect(dependencies.getByRole("option")).toHaveCount(10);
    await dependencies.getByRole("button", { name: "Blocked by", exact: true }).click();
    await expect(dependencies.getByRole("option")).toHaveCount(1);
    await dependencies.getByRole("option").click();
    await expect(dependencies.locator(".cr-row").filter({ hasText: eligible.key })).toBeVisible();
  } finally {
    for (const card of [blocked, ...candidates]) await api.patch(`/api/cards/${card.id}/archive`, { data: { archived: true } });
  }
});

// Global Work filters on the server (`blockedOnly`), unlike the board's local quick filter, so the
// chip and the filter must agree on the same definition: open blockers only, hidden ones included.
test("the Blocked quick filter in Global Work keeps only cards waiting on an open blocker", async ({ page, signIn, apiAs, uniqueName }) => {
  await signIn(page, "amelia");
  await openBoard(page, "E2E primary board");
  const api = await apiAs("amelia");
  const me = (await (await api.get("/api/me")).json()) as { id?: string; user?: { id: string } };
  const ameliaId = me.user?.id ?? me.id!;
  const waiting = await createCardOnBoard(page, api, "E2E primary board", uniqueName("E2E waiting on migration"));
  const free = await createCardOnBoard(page, api, "E2E primary board", uniqueName("E2E free to start"));
  const blocker = await createCardOnBoard(page, api, "E2E secondary board", uniqueName("E2E global blocker"));
  for (const card of [waiting, free]) {
    expect((await api.put(`/api/cards/${card.id}/assignees`, { data: { userIds: [ameliaId] } })).ok()).toBe(true);
  }
  const linked = await api.post(`/api/cards/${waiting.id}/relations`, { data: { targetCardId: blocker.id, direction: "blocked_by" } });
  expect(linked.status(), await linked.text()).toBe(201);

  try {
    await page.goto("/my-cards");
    await expect(cardTile(page, waiting.title)).toHaveCount(1);
    await expect(cardTile(page, free.title)).toHaveCount(1);
    await expect(cardTile(page, waiting.title).locator(".card-blocked")).toHaveText("Blocked");

    const filtered = page.waitForResponse((response) => response.url().endsWith("/api/work/cards/query") && response.request().method() === "POST" && (response.request().postDataJSON() as { filters?: { blockedOnly?: boolean } }).filters?.blockedOnly === true);
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page.locator(".fb-row").filter({ hasText: /^Blocked/ }).click();
    await filtered;
    await page.keyboard.press("Escape");
    await expect(cardTile(page, free.title)).toHaveCount(0);
    await expect(cardTile(page, waiting.title)).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath("global-work-blocked-filter.png") });

    // Completing the blocker frees the card: the server no longer returns it for this filter.
    expect((await api.patch(`/api/cards/${blocker.id}/completion`, { data: { completed: true } })).ok()).toBe(true);
    // Active filters add a count to the label; keep the prefix match inside the filter bar
    // so workspace names beginning with "Filter" cannot match the same locator.
    await page.locator("k-filter-bar").getByRole("button", { name: /^Filter/ }).click();
    await page.locator(".fb-row").filter({ hasText: /^Blocked/ }).click();
    await page.locator(".fb-row").filter({ hasText: /^Blocked/ }).click();
    await page.keyboard.press("Escape");
    await expect(cardTile(page, waiting.title)).toHaveCount(0);
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(cardTile(page, waiting.title)).toHaveCount(1);
  } finally {
    for (const card of [waiting, free, blocker]) {
      expect((await api.patch(`/api/cards/${card.id}/archive`, { data: { archived: true } })).ok()).toBe(true);
    }
  }
});
