import { expandCardSummary, type CompactCardSummary } from "../packages/shared/src/events";
import { expect, test } from "./support/fixtures";

// A reset must not turn separators into list headings or leave them after a lone card.
test("seeded separators divide card groups instead of heading lists", async ({ page, apiAs, signIn }, testInfo) => {
  const api = await apiAs("amelia");
  const response = await api.get("/api/boards");
  expect(response.ok()).toBe(true);
  const boards = await response.json() as { id: string; name: string; workspaceId: string }[];
  const launch = boards.find(board => board.name === "Autumn Campaign Launch")!;
  const boundaries: { board: string; list: string; title: string }[] = [];
  for (const board of boards) {
    const openedResponse = await api.post(`/api/boards/${board.id}/open?includeCompleted=true`);
    expect(openedResponse.ok()).toBe(true);
    const opened = await openedResponse.json() as {
      cards: CompactCardSummary[];
      lists: { id: string; name: string }[];
      separators: { id: string; listId: string; title: string; position: string }[];
    };
    const cards = opened.cards.map(expandCardSummary);
    for (const separator of opened.separators) {
      const list = opened.lists.find(list => list.id === separator.listId)!;
      const group = cards.filter(card => card.listId === separator.listId);
      const label = `${board.name} / ${list.name} / ${separator.title}`;
      expect(group.some(card => Number(card.position) < Number(separator.position)), `${label}: card before`).toBe(true);
      expect(group.some(card => Number(card.position) > Number(separator.position)), `${label}: card after`).toBe(true);
      boundaries.push({ board: board.name, list: list.name, title: separator.title });
    }
    if (board.id === launch.id) expect(opened.separators).toEqual([]);
  }
  const marketingBoards = boards.filter(board => board.workspaceId === launch.workspaceId).map(board => board.name);
  expect(boundaries.filter(boundary => marketingBoards.includes(boundary.board)).map(boundary => boundary.title).sort())
    .toEqual(["Editorial planning", "Future events", "Recruitment", "Sales requests", "Sales rollout", "Website improvements"]);
  await testInfo.attach("seed-separator-boundaries", { body: JSON.stringify(boundaries, null, 2), contentType: "application/json" });

  await signIn(page, "amelia", `/b/${launch.id}`);
  await expect(page.locator("k-board-page k-board")).toBeVisible();
  await expect(page.locator("k-board k-separator")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("launch-without-leading-separators-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("k-board k-separator")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("launch-without-leading-separators-phone.png") });

  const brand = boards.find(board => board.name === "Brand Refresh")!;
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`/b/${brand.id}`);
  const boundary = page.locator("k-separator").filter({ hasText: "Sales rollout" });
  await expect(boundary).toBeVisible();
  const lane = page.locator("k-list").filter({ has: boundary });
  expect(await lane.locator(".cards > k-card, .cards > k-separator").evaluateAll(items => items.map(item => item.tagName)))
    .toEqual(["K-CARD", "K-CARD", "K-CARD", "K-SEPARATOR", "K-CARD"]);
  await page.screenshot({ path: testInfo.outputPath("brand-separator-between-groups-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await boundary.scrollIntoViewIfNeeded();
  await expect(boundary).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("brand-separator-between-groups-phone.png") });
});
