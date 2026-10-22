import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";

async function dragBelow(page: Page, row: Locator, target: Locator, boardId: string) {
  await target.scrollIntoViewIfNeeded();
  await row.scrollIntoViewIfNeeded();
  const grip = (await row.locator(".grip").boundingBox())!;
  const destination = (await target.boundingBox())!;
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 8, y + 8, { steps: 4 });
  await page.mouse.move(x, destination.y + destination.height * 0.8, { steps: 20 });
  const saved = page.waitForResponse((response) => response.url().endsWith(`/boards/${boardId}/move`) && response.request().method() === "POST");
  await page.mouse.up();
  const response = await saved;
  expect(response.ok(), await response.text()).toBe(true);
  return response.request().postDataJSON() as { afterBoardId: string };
}

test("workspace settings follow navigation board order with group headings and scoped drags", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("kanera-theme", "dark"));
  const api = await apiAs("amelia");
  const name = uniqueName("Board ordering");
  const created = await api.post("/api/workspaces", { data: {
    name, initialBoard: { name: "Ungrouped first" }, listNames: ["To do", "Done"], customFields: [],
  } });
  expect(created.ok(), await created.text()).toBe(true);
  const workspace = await created.json() as { id: string; initialBoard: { id: string } };
  try {
    const boardResponse = await api.get(`/api/boards/${workspace.initialBoard.id}?includeCards=false`);
    expect(boardResponse.ok()).toBe(true);
    const { lists } = await boardResponse.json() as { lists: { id: string }[] };
    // Nonempty counts prove a loaded summary would have shown the old completion bar.
    for (const completed of [false, true]) {
      const response = await api.post(`/api/boards/${workspace.initialBoard.id}/lists/${lists[0]!.id}/cards`, { data: { title: completed ? "Completed work" : "Open work" } });
      expect(response.ok()).toBe(true);
      const card = await response.json() as { id: string };
      if (completed) expect((await api.patch(`/api/cards/${card.id}/completion`, { data: { completed: true } })).ok()).toBe(true);
    }
    const groups: Record<string, string> = {};
    for (const title of ["Zulu", "Alpha", "Empty"]) {
      const response = await api.post(`/api/workspaces/${workspace.id}/board-groups`, { data: { title } });
      expect(response.ok(), await response.text()).toBe(true);
      groups[title] = (await response.json() as { id: string }).id;
    }
    expect((await api.post(`/api/board-groups/${groups.Alpha}/move`, { data: { beforeGroupId: groups.Zulu } })).ok()).toBe(true);
    const ids: Record<string, string> = { "Ungrouped first": workspace.initialBoard.id };
    // Deliberately interleave global positions across groups and put ungrouped boards first.
    for (const [boardName, groupId] of [
      ["Zulu first", groups.Zulu], ["Alpha first", groups.Alpha], ["Zulu second", groups.Zulu],
      ["Ungrouped second", null], ["Alpha second", groups.Alpha],
    ] as const) {
      const response = await api.post(`/api/workspaces/${workspace.id}/boards`, { data: { name: boardName, groupId } });
      expect(response.ok(), await response.text()).toBe(true);
      ids[boardName] = (await response.json() as { id: string }).id;
    }
    await signIn(page, "amelia");
    await page.goto(`/w/${workspace.id}/settings/boards`);
    const settings = page.locator("k-workspace-settings-boards");
    const names = settings.locator(".board-row .board-name");
    const nav = page.locator(".ws-group").filter({ has: page.locator(`a[href="/w/${workspace.id}/settings"]`) });
    const navNames = nav.locator('.board-link[href^="/b/"] .nav-label');
    const expected = ["Alpha first", "Alpha second", "Zulu first", "Zulu second", "Ungrouped first", "Ungrouped second"];
    await expect(names).toHaveText(expected);
    await expect(settings.getByRole("heading", { level: 3 })).toHaveText(["Alpha", "Zulu", "Ungrouped"]);
    await expect(navNames).toHaveText(expected);
    const row = (boardName: string) => settings.locator(".board-row").filter({ has: page.getByText(boardName, { exact: true }) });
    await expect(row("Ungrouped first").locator(".bts-stat")).toContainText(["1 open"]);
    await expect(settings.locator(".bts-progress")).toHaveCount(0);
    expect(await dragBelow(page, row("Alpha first"), row("Alpha second"), ids["Alpha first"]!)).toEqual({ afterBoardId: ids["Alpha second"] });
    expected.splice(0, 2, "Alpha second", "Alpha first");
    await expect(names).toHaveText(expected);
    await expect(navNames).toHaveText(expected);
    expect(await dragBelow(page, row("Ungrouped first"), row("Ungrouped second"), ids["Ungrouped first"]!)).toEqual({ afterBoardId: ids["Ungrouped second"] });
    expected.splice(4, 2, "Ungrouped second", "Ungrouped first");
    await expect(names).toHaveText(expected);
    await expect(navNames).toHaveText(expected);

    // A remote group move must update both mounted surfaces without a refresh.
    expect((await api.post(`/api/board-groups/${groups.Zulu}/move`, { data: { beforeGroupId: groups.Alpha } })).ok()).toBe(true);
    const reordered = ["Zulu first", "Zulu second", ...expected.slice(0, 2), ...expected.slice(4)];
    await expect(names).toHaveText(reordered);
    await expect(navNames).toHaveText(reordered);
    await expect(settings.getByRole("heading", { level: 3 })).toHaveText(["Zulu", "Alpha", "Ungrouped"]);
    const saved = page.waitForResponse((response) => response.url().endsWith(`/boards/${ids["Zulu second"]}`) && response.request().method() === "PATCH");
    await row("Zulu second").getByRole("combobox", { name: "Board group" }).selectOption(groups.Alpha!);
    expect((await saved).ok()).toBe(true);
    await expect(names).toHaveText(reordered);
    await expect(navNames).toHaveText(reordered);
    await expect(settings.locator(".board-section").nth(0).locator(".board-name")).toHaveText(["Zulu first"]);
    await expect(settings.locator(".board-section").nth(1).locator(".board-name")).toHaveText(["Zulu second", "Alpha second", "Alpha first"]);
    await expect(nav.locator(".board-nav-group").filter({ has: page.locator(".board-group-toggle span").filter({ hasText: /^Alpha$/ }) }).locator(".nav-label"))
      .toHaveText(["Zulu second", "Alpha second", "Alpha first"]);
    await page.reload();
    await expect(names).toHaveText(reordered);
    await expect(navNames).toHaveText(reordered);
    await expect(row("Ungrouped first").locator(".bts-stat")).toContainText(["1 open"]);
    await expect(settings.locator(".bts-progress")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("workspace-board-order-desktop.png"), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(names).toHaveText(reordered);
    await expect(settings.getByRole("heading", { level: 3 })).toHaveText(["Zulu", "Alpha", "Ungrouped"]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // Let the sidebar finish collapsing, then check the controls inside each tile, not just the page.
    await expect.poll(() => settings.locator(".board-row").evaluateAll((rows) => rows.every((element) => element.scrollWidth <= element.clientWidth))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("workspace-board-order-phone.png"), fullPage: true, animations: "disabled" });
  } finally {
    expect((await api.delete(`/api/workspaces/${workspace.id}`, { data: { confirmationName: name } })).ok()).toBe(true);
  }
});
