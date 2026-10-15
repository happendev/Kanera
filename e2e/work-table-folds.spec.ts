import type { APIResponse, Response } from "@playwright/test";
import { expect, test } from "./support/fixtures";

async function result<T>(response: APIResponse | Response): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

test("Global Work table folds survive saving a view, reloading and realtime refresh", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const workspaceName = uniqueName("Folded workspace");
  const workspace = await result<{ id: string; initialBoard: { id: string } }>(await api.post("/api/workspaces", {
    data: { name: workspaceName, initialBoard: { name: workspaceName }, listNames: ["To do", "Done"], customFields: [] },
  }));
  let viewId: string | undefined;
  try {
    const owner = await result<{ id: string }>(await api.get("/api/me"));
    const board = await result<{ lists: Array<{ id: string }> }>(await api.get(`/api/boards/${workspace.initialBoard.id}?includeCards=false`));
    const title = uniqueName("Folded card");
    const card = await result<{ id: string }>(await api.post(`/api/boards/${workspace.initialBoard.id}/lists/${board.lists[0]!.id}/cards`, { data: { title, assigneeIds: [owner.id] } }));
    await signIn(page, "amelia");
    await page.goto("/my-cards");
    await page.getByRole("button", { name: "Table view", exact: true }).click();
    const row = page.locator(`.tv-row[data-card-id="${card.id}"]`);
    await expect(row).toBeVisible();
    await page.locator("button.k-toolbar-trigger").filter({ has: page.locator(".ti-layout-rows") }).click();
    await page.locator("k-anchored-picker").getByRole("button", { name: /Workspace$/ }).click();
    const collapse = page.getByRole("button", { name: `Collapse ${workspaceName}`, exact: true });
    const expand = page.getByRole("button", { name: `Expand ${workspaceName}`, exact: true });
    await collapse.click();
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await expect(row).toHaveCount(0);
    await page.getByRole("button", { name: /Save view$/ }).click();
    await page.getByPlaceholder("e.g. Launch risks").fill(uniqueName("Folded view"));
    const saved = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/work-views"));
    await page.locator("k-save-view").getByRole("button", { name: "Save view", exact: true }).click();
    const view = await result<{ id: string; definition: { table: { collapsedGroupKeys: string[] } } }>(await saved);
    viewId = view.id;
    expect(view.definition.table.collapsedGroupKeys).toContain(`workspace:${workspace.id}`);
    await page.reload();
    await expect(expand).toBeVisible();
    await expect(row).toHaveCount(0);
    const nextTitle = `${title} updated`;
    const refreshed = page.waitForResponse((response) => response.url().endsWith("/api/work/cards/query") && response.request().method() === "POST");
    await result(await api.patch(`/api/cards/${card.id}`, { data: { title: nextTitle } }));
    await (await refreshed).finished();
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await expect(row).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("folded-work-table-desktop.png"), fullPage: true });
    await expand.click();
    await expect(row).toContainText(nextTitle);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(row).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("expanded-work-table-phone.png"), fullPage: true, animations: "disabled" });
  } finally {
    if (viewId) expect((await api.delete(`/api/work-views/${viewId}`)).ok()).toBe(true);
    expect((await api.delete(`/api/workspaces/${workspace.id}`, { data: { confirmationName: workspaceName } })).ok()).toBe(true);
  }
});
