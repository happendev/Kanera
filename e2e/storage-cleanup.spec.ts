import { expect, test } from "./support/fixtures";
import { expectBoardLoaded, openCard } from "./support/ui";

// Settings → Organisation → Storage is an admin cleanup tool. Deleting a file there must behave like
// deleting it on the card: the file leaves the card for everyone, live, through the same realtime
// path (card route echo → outbox → worker → Valkey → other clients).
test("an admin deletes a card file from Storage and an open card loses it live", async ({ page, signIn, pageAs, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const name = uniqueName("E2E storage cleanup");
  const created = await api.post("/api/workspaces", {
    data: { name, initialBoard: { name }, listNames: ["To do", "Done"], customFields: [] },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspace = await created.json() as { id: string; initialBoard: { id: string } };
  const boardId = workspace.initialBoard.id;
  const board = await (await api.get(`/api/boards/${boardId}?includeCards=false`)).json() as { lists: { id: string }[] };
  const card = await api.post(`/api/boards/${boardId}/lists/${board.lists[0]!.id}/cards`, { data: { title: name } });
  expect(card.ok(), await card.text()).toBe(true);
  const { id: cardId } = await card.json() as { id: string };
  const fileName = `${name.replace(/[^A-Za-z0-9-]+/g, "-")}.txt`;
  const uploaded = await api.post(`/api/cards/${cardId}/attachments`, {
    multipart: { file: { name: fileName, mimeType: "text/plain", buffer: Buffer.alloc(256 * 1024, "k") } },
  });
  expect(uploaded.ok(), await uploaded.text()).toBe(true);

  // A teammate has the card open while the admin cleans up.
  const teammate = await pageAs("marcus");
  await teammate.goto(`/b/${boardId}`);
  await expectBoardLoaded(teammate, name);
  const detail = await openCard(teammate, name);
  await expect(detail.locator(".attach-name").filter({ hasText: fileName })).toBeVisible();

  await signIn(page, "amelia");
  await page.goto("/settings/storage");
  const tabs = page.getByRole("navigation", { name: "Settings sections" });
  await expect(tabs.getByText("Your account", { exact: true })).toBeVisible();
  await expect(tabs.getByText("Organisation", { exact: true })).toBeVisible();
  await expect(tabs.getByRole("link", { name: "Storage" })).toHaveClass(/\bactive\b/);
  await expect(page.locator(".storage-usage-used")).toBeVisible();

  await page.getByRole("combobox", { name: "Workspace" }).selectOption({ label: name });
  const row = page.locator(".storage-file").filter({ hasText: fileName });
  await expect(row).toHaveCount(1);
  await expect(page.locator(".storage-file")).toHaveCount(1);
  await expect(row).toContainText(name);
  await expect(row).toContainText("256.0 KB");
  await page.screenshot({ path: testInfo.outputPath("storage-settings.png"), fullPage: true });

  await row.getByRole("checkbox").check();
  await page.getByRole("button", { name: /Delete 1 · 256\.0 KB/ }).click();
  const confirm = page.getByRole("dialog", { name: "Delete this file?" });
  await expect(confirm).toContainText("256.0 KB");
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Deleted 1 file, freeing 256.0 KB")).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(page.getByText("No files match these filters.")).toBeVisible();

  await expect(detail.locator(".attach-name").filter({ hasText: fileName })).toHaveCount(0);
  await teammate.screenshot({ path: testInfo.outputPath("teammate-card-after-cleanup.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/storage");
  await expect(page.locator(".storage-usage-used")).toBeVisible();
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("storage-settings-mobile.png"), fullPage: true });

  const removed = await api.delete(`/api/workspaces/${workspace.id}`, { data: { confirmationName: name } });
  expect(removed.ok(), await removed.text()).toBe(true);
});
