import { expect, test } from "./support/fixtures";

type SeedCard = {
  id: string; title: string; listId: string; completedAt: string | null;
  inProgressSince: string | null; inProgressSeconds: number;
};
type SeedList = { id: string; name: string; inProgress: boolean };

// Read the real seed through the API, then open a completed card as a user. No test-created cards
// can hide a missing seed movement path or a clock incorrectly restarted by the list backfill.
test("seeded lists track progress and completed cards retain historical working time", async ({ page, apiAs, signIn }, testInfo) => {
  const api = await apiAs("amelia");
  const workspaceResponse = await api.get("/api/workspaces");
  expect(workspaceResponse.ok()).toBe(true);
  const workspaces = await workspaceResponse.json() as { id: string; name: string }[];
  const boardResponse = await api.get("/api/boards");
  expect(boardResponse.ok()).toBe(true);
  const boards = await boardResponse.json() as { id: string; workspaceId: string; name: string }[];
  const evidence: unknown[] = [];
  let preview: { boardId: string; card: SeedCard } | undefined;

  for (const [workspaceName, progressName] of [
    ["Development Team", "In Progress"], ["Marketing & Creative", "In Progress"],
    ["DevOps", "Implementing"], ["Launch Checklist", "In progress"],
  ]) {
    // Standalone boards hide their internal workspace from the workspace directory.
    const workspace = workspaceName === "Launch Checklist"
      ? { id: boards.find((row) => row.name === workspaceName)!.workspaceId, name: workspaceName }
      : workspaces.find((row) => row.name === workspaceName)!;
    expect(workspace, workspaceName).toBeTruthy();
    const workspaceBoards = boards.filter((row) => row.workspaceId === workspace.id);
    expect(workspaceBoards.length).toBeGreaterThan(0);
    let trackedCompleted = 0;
    let trackedSample: SeedCard | undefined;
    for (const board of workspaceBoards) {
      const response = await api.post(`/api/boards/${board.id}/open?includeCompleted=true`);
      expect(response.ok(), await response.text()).toBe(true);
      const data = await response.json() as { lists: SeedList[]; cards: SeedCard[] };
      expect(data.lists.filter((list) => list.inProgress).map((list) => list.name)).toEqual([progressName]);
      const completedResponse = await api.get(`/api/boards/${board.id}/completed?limit=100`);
      expect(completedResponse.ok()).toBe(true);
      const completed = (await completedResponse.json() as { cards: SeedCard[] }).cards;
      for (const card of completed) {
        expect(card.inProgressSince, card.title).toBeNull();
        expect(card.inProgressSeconds, card.title).toBeGreaterThanOrEqual(0);
        // The seeded progress stage cannot count nights/weekends as continuous work.
        expect(card.inProgressSeconds, card.title).toBeLessThanOrEqual(5 * 8 * 3600);
        if (card.inProgressSeconds > 0) {
          trackedCompleted++;
          trackedSample ??= card;
          preview ??= { boardId: board.id, card };
        }
      }
      for (const card of data.cards.filter((card) => !card.completedAt)) {
        const list = data.lists.find((list) => list.id === card.listId)!;
        if (list.inProgress) expect(typeof card.inProgressSince, card.title).toBe("string");
        else expect(card.inProgressSince ?? null, card.title).toBeNull();
      }
      evidence.push({ workspaceName, boardName: board.name, completed });
    }
    expect(trackedCompleted, `${workspaceName} completed cards with banked time`).toBeGreaterThan(0);
    const feedResponse = await api.get(`/api/cards/${trackedSample!.id}/feed?limit=100`);
    expect(feedResponse.ok()).toBe(true);
    const feed = await feedResponse.json() as { items: { type: string; data: { action?: string; payload?: { fromListName?: string } } }[] };
    expect(feed.items.some((item) => item.type === "activity" && item.data.action === "moved" && item.data.payload?.fromListName === progressName)).toBe(true);
  }

  const guestApi = await apiAs("maya");
  const guestBoardsResponse = await guestApi.get("/api/boards");
  expect(guestBoardsResponse.ok()).toBe(true);
  const guestBoard = (await guestBoardsResponse.json() as { id: string; name: string }[]).find((board) => board.name === "Todo")!;
  const guestResponse = await guestApi.post(`/api/boards/${guestBoard.id}/open`);
  expect(guestResponse.ok()).toBe(true);
  const guest = await guestResponse.json() as { lists: SeedList[]; cards: SeedCard[] };
  expect(guest.lists.filter((list) => list.inProgress).map((list) => list.name)).toEqual(["Doing"]);
  for (const card of guest.cards) {
    if (guest.lists.find((list) => list.id === card.listId)!.inProgress) expect(typeof card.inProgressSince).toBe("string");
    else expect(card.inProgressSince ?? null).toBeNull();
  }

  await testInfo.attach("seeded-progress-clocks", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
  expect(preview).toBeTruthy();
  await signIn(page, "amelia");
  await page.goto(`/b/${preview!.boardId}/c/${preview!.card.id}`);
  const detail = page.getByRole("dialog", { name: `Card detail: ${preview!.card.title}` });
  await expect(detail).toBeVisible();
  await expect(detail.locator(".col-main .detail-time-in-progress")).toContainText("Time in progress");
  await expect(detail.locator(".col-main .detail-time-in-progress strong")).not.toHaveText("0m");
});
