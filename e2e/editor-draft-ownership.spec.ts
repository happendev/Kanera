import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./support/fixtures";

async function drafts(page: Page) {
  return page.evaluate(() => localStorage.getItem("kanera:editor-drafts") ?? "{}");
}

async function evidence(page: Page, info: TestInfo, comments = false) {
  await page.screenshot({ path: info.outputPath("preserved-desktop.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  if (comments) await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.screenshot({ path: info.outputPath("preserved-phone.png"), animations: "disabled" });
}

for (const surface of ["description", "comment-new", "comment-edit"] as const) {
  test(`${surface}: saving in another tab cannot clear this tab's draft`, async ({ page, signIn, apiAs, testWorkspace }, info) => {
    const api = await apiAs("amelia");
    const created = await api.post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")}/cards`, {
      data: { title: "Draft ownership", description: "Original text" },
    });
    expect(created.ok()).toBe(true);
    const card = await created.json() as { id: string };
    if (surface === "comment-edit") {
      expect((await api.post(`/api/cards/${card.id}/comments`, { data: { body: "Original text" } })).ok()).toBe(true);
    }
    const url = `/b/${testWorkspace.boardId}/c/${card.id}`;
    await signIn(page, "amelia", url);
    const other = await page.context().newPage();
    await other.goto(url);
    const host = (tab: Page) => tab.locator(surface === "description" ? "k-card-detail-description" : surface === "comment-new" ? ".comment-form" : ".comment").first();
    const start = (tab: Page) => surface === "description"
      ? host(tab).locator(".description-viewer-wrap")
      : host(tab).getByRole("button", { name: surface === "comment-new" ? "Write a comment..." : "Edit", exact: true });
    // Finish mounting both tabs before writing the first draft; otherwise the second tab may
    // restore it automatically during startup and already be editing when we try to click Edit.
    await expect(start(other)).toBeVisible();
    for (const tab of [page, other]) {
      await start(tab).click();
      await host(tab).locator(".tiptap").fill(tab === page ? "First tab draft" : "Published from second tab");
    }
    // The first tab's latest work is the shared recovery copy when the second tab saves.
    const text = "First tab draft continued";
    await host(page).locator(".tiptap").fill(text);
    await expect.poll(() => drafts(page)).toContain(text);
    await host(other).getByRole("button", { name: surface === "comment-new" ? "Send" : "Save", exact: true }).click();
    await expect(host(other).locator(".tiptap")).toHaveCount(0);
    await expect.poll(() => drafts(page)).toContain(text);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.reload();
    await expect(host(page)).toContainText(text);
    await evidence(page, info, surface !== "description");
  });
}

test("a checklist description save cannot clear a newer edit after reopening its drawer", async ({ page, signIn, apiAs, testWorkspace }, info) => {
  const api = await apiAs("amelia");
  const created = await api.post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")}/cards`, { data: { title: "Checklist recovery" } });
  expect(created.ok()).toBe(true);
  const card = await created.json() as { id: string };
  const checklistResponse = await api.post(`/api/cards/${card.id}/checklists`, { data: { title: "Checklist" } });
  expect(checklistResponse.ok()).toBe(true);
  const checklist = await checklistResponse.json() as { id: string };
  const itemResponse = await api.post(`/api/cards/${card.id}/checklists/${checklist.id}/items`, { data: { text: "Item" } });
  expect(itemResponse.ok()).toBe(true);
  const item = await itemResponse.json() as { id: string };
  const endpoint = `/api/cards/${card.id}/checklists/${checklist.id}/items/${item.id}`;
  await signIn(page, "amelia", `/b/${testWorkspace.boardId}/c/${card.id}`);
  const panel = page.locator(".checklist-item-panel");
  const open = async () => {
    await page.locator(".checklist-item-text").filter({ hasText: /^Item$/ }).click();
    await expect(panel.locator(".tiptap").or(panel.locator(".description-viewer-wrap"))).toBeVisible();
    if (!await panel.locator(".tiptap").isVisible()) await panel.locator(".description-viewer-wrap").click();
    await expect(panel.locator(".tiptap")).toBeEditable();
  };
  await open();
  await panel.locator(".tiptap").fill("First submitted text");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  await page.route(`**${endpoint}`, async (route) => {
    if (held || route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    held = true;
    await pending;
    await route.fulfill({ response });
  });
  try {
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => held).toBe(true);
    page.once("dialog", (dialog) => void dialog.accept());
    await panel.getByRole("button", { name: "Back to card", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await open();
    const text = "Newer checklist description";
    await panel.locator(".tiptap").fill(text);
    const acknowledged = page.waitForResponse((response) => response.url().endsWith(endpoint) && response.request().method() === "PATCH");
    release();
    expect((await acknowledged).ok()).toBe(true);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(panel.locator(".tiptap")).toHaveText(text);
    await expect.poll(() => drafts(page)).toContain(text);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.reload();
    await open();
    await expect(panel.locator(".tiptap")).toHaveText(text);
    await evidence(page, info);
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.locator(".tiptap")).toHaveCount(0);
    await expect(panel).toContainText(text);
  } finally {
    release();
  }
});
