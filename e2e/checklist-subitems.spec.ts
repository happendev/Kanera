import type { Locator } from "@playwright/test";
import { expect, test } from "./support/scenario";
import { boardIdOf, openBoard, openCard } from "./support/ui";

// Sub-items expand inline under their checklist item and tick there, and the item menu reorders by
// keyboard. A second user's open card is the observer, so every check on it is realtime.

function itemRow(block: Locator, text: string): Locator {
  return block.locator(".checklist-items > .checklist-item").filter({ has: block.page().locator(".checklist-item-label", { hasText: text }) });
}

test("sub-items tick inline and items reorder from the keyboard, live for other viewers", async ({ page, signIn, pageAs, apiAs, uniqueName }) => {
  const title = uniqueName("E2E checklist sub-items");
  await signIn(page, "amelia");
  const api = await apiAs("amelia");
  const boardId = await boardIdOf(page, "E2E primary board");
  const board = (await (await api.get(`/api/boards/${boardId}?includeCards=false`)).json()) as { lists: { id: string; name: string }[] };
  const backlog = board.lists.find((list) => list.name === "Backlog")!;
  const created = await api.post(`/api/boards/${boardId}/lists/${backlog.id}/cards`, { data: { title } });
  expect(created.ok(), await created.text()).toBe(true);
  const cardId = ((await created.json()) as { id: string }).id;
  const checklist = await api.post(`/api/cards/${cardId}/checklists`, {
    data: {
      title: "Release",
      items: [
        { text: "Write notes", subChecklists: [{ title: "Steps", items: [{ text: "Draft" }, { text: "Review", completed: true }] }] },
        { text: "Tag build" },
        { text: "Announce" },
      ],
    },
  });
  expect(checklist.ok(), await checklist.text()).toBe(true);
  const checklistId = ((await checklist.json()) as { id: string }).id;

  const viewer = await pageAs("marcus");
  await openBoard(viewer, "E2E primary board");
  const viewerBlock = (await openCard(viewer, title)).locator(`.checklist-block[data-checklist-id="${checklistId}"]`);
  await openBoard(page, "E2E primary board");
  const block = (await openCard(page, title)).locator(`.checklist-block[data-checklist-id="${checklistId}"]`);

  // Collapsed by default: the row carries the sub-item count, not the sub-items.
  const notes = itemRow(block, "Write notes");
  const toggle = notes.getByRole("button", { name: "Sub-items" });
  await expect(toggle).toHaveText(/1\/2/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(notes.locator(".checklist-subitem")).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const draft = notes.locator(".checklist-subitem").filter({ hasText: "Draft" });
  await expect(notes.locator(".checklist-subitem")).toHaveCount(2);
  await draft.locator(".checklist-check").click();
  await expect(draft.locator(".checklist-check")).toHaveClass(/checked/);
  await expect(toggle).toHaveText(/2\/2/);
  await expect(toggle).toHaveClass(/is-complete/);
  // The observer never expanded the row; its count still converges on the tick.
  await expect(itemRow(viewerBlock, "Write notes").getByRole("button", { name: "Sub-items" })).toHaveText(/2\/2/);

  // Keyboard reorder: the first item has no "Move up", and a move returns focus to the moved row's
  // menu button so the next step is one key press away.
  const labels = block.locator(".checklist-items > .checklist-item .checklist-item-label");
  await itemRow(block, "Write notes").getByRole("button", { name: "Checklist item actions" }).press("Enter");
  await expect(page.getByRole("menuitem", { name: "Move up" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  const announceMenu = itemRow(block, "Announce").getByRole("button", { name: "Checklist item actions" });
  await announceMenu.press("Enter");
  await page.getByRole("menuitem", { name: "Move up" }).press("Enter");
  await expect(labels).toHaveText(["Write notes", "Announce", "Tag build"]);
  await expect(itemRow(block, "Announce").getByRole("button", { name: "Checklist item actions" })).toBeFocused();
  await expect(viewerBlock.locator(".checklist-items > .checklist-item .checklist-item-label")).toHaveText(["Write notes", "Announce", "Tag build"]);

  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Move down" }).press("Enter");
  await expect(labels).toHaveText(["Write notes", "Tag build", "Announce"]);
  await expect(viewerBlock.locator(".checklist-items > .checklist-item .checklist-item-label")).toHaveText(["Write notes", "Tag build", "Announce"]);
});
