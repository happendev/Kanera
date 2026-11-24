import type { APIResponse } from "@playwright/test";
import { test, expect } from "./support/fixtures";

async function result<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

test("Up next flags a queue someone else changed until its owner opens it", async ({ page, signIn, apiAs, testWorkspace, uniqueName }, testInfo) => {
  const manager = await apiAs("amelia");
  const owner = await apiAs("priya");
  const me = await result<{ id: string }>(await owner.get("/api/me"));
  const cardsUrl = `/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")!}/cards`;
  const [first, second, third] = await Promise.all(["First", "Second", "Third"].map(async (label) =>
    result<{ id: string }>(await manager.post(cardsUrl, { data: { title: uniqueName(label), assigneeIds: [me.id] } }))));
  const queueUrl = `/api/work/priorities/${me.id}/cards`;

  await signIn(page, "priya");
  const button = page.locator("aside.sidebar .utility-row").getByRole("button", { name: /^Up next/ });
  const changed = /changed by someone else/;
  await expect(button).toBeVisible();

  // The owner's own gesture is not news to them.
  await result(await owner.post(queueUrl, { data: { cardId: first!.id, beforeId: null } }));
  await expect(button).toHaveAccessibleName("Up next (1 cards)");
  await expect(button.locator(".utility-badge.is-unread")).toHaveCount(0);

  // A coordinator's change arrives live, without anyone telling them.
  await result(await manager.post(queueUrl, { data: { cardId: second!.id, beforeId: null } }));
  await expect(button).toHaveAccessibleName(changed);
  await expect(button.locator(".utility-badge.is-unread")).toHaveText("2");
  await page.screenshot({ path: testInfo.outputPath("up-next-changed-desktop.png") });

  // Opening the drawer acknowledges it, and the acknowledgement is stored, not per tab.
  await button.click();
  await expect(page.getByRole("dialog", { name: "Up next", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(button).not.toHaveAccessibleName(changed);
  await page.reload();
  await expect(button).toHaveAccessibleName("Up next (2 cards)");

  // On a phone the button sits inside the closed drawer, so the header's menu button carries it.
  await page.setViewportSize({ width: 390, height: 844 });
  const menuDot = page.locator(".ph-menu .ph-menu-dot.is-changed");
  await expect(menuDot).toHaveCount(0);
  await result(await manager.post(queueUrl, { data: { cardId: third!.id, beforeId: null } }));
  await expect(menuDot).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("up-next-changed-phone.png") });
});
