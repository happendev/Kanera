import type { APIResponse, Locator } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { openCard } from "./support/ui";

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

// Check controls remain reachable in each layout mode; cosmetic theme recipes belong outside E2E.
test("card detail controls stay reachable on desktop and phone", async ({ page, apiAs, signIn, testWorkspace, uniqueName }) => {
  const api = await apiAs("amelia");
  const title = uniqueName("Detail layout");
  const me = await json<{ id: string }>(await api.get("/api/me"));
  const card = await json<{ id: string }>(await api.post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")}/cards`, {
    data: { title, description: "A **formatted description** with a [reference](https://example.com).\n\n- First detail\n- Second detail", assigneeIds: [me.id], dueDateLocalDate: "2030-11-04" },
  }));
  const label = await json<{ id: string }>(await api.post(`/api/workspaces/${testWorkspace.id}/card-labels`, { data: { name: "Layout label", color: "purple" } }));
  await json(await api.put(`/api/cards/${card.id}/labels`, { data: { labelIds: [label.id] } }));
  for (const field of [{ name: "Branch", type: "text" }, { name: "Reviewed", type: "checkbox" }, { name: "Priority", type: "select", options: [{ label: "High" }, { label: "Low" }] }]) {
    await json(await api.post(`/api/workspaces/${testWorkspace.id}/custom-fields`, { data: field }));
  }
  await json(await api.post(`/api/cards/${card.id}/checklists`, { data: { title: "Review checklist", items: [{ text: "Check the desktop layout" }, { text: "Check phone layout and controls" }] } }));
  await json(await api.post(`/api/cards/${card.id}/attachments`, { multipart: { file: { name: "layout-notes.txt", mimeType: "text/plain", buffer: Buffer.from("Layout fixture") } } }));
  await json(await api.post(`/api/cards/${card.id}/comments`, { data: { body: "A **formatted comment** for the activity panel." } }));
  await signIn(page, "amelia", `/b/${testWorkspace.boardId}`);
  const detail = await openCard(page, title);
  await expect(detail.locator(".cf-row")).toHaveCount(3);
  await expect(detail.locator(".attach-row")).toHaveCount(1);
  await page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; }" });
  await page.evaluate(() => document.fonts.ready);

  const insideViewport = async (target: Locator) => {
    await expect(target).toBeVisible();
    const box = (await target.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.y).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  };
  for (const [width, modal] of [[1440, false], [1440, true], [390, true]] as const) {
    await page.setViewportSize({ width, height: 900 });
    if (width >= 1024 && (await detail.getAttribute("class"))!.includes("mode-modal") !== modal) await detail.locator(".layout-mode-btn").click();
    await detail.locator(".col-main").evaluate((element) => { element.scrollTop = 0; });
    await insideViewport(detail);
    expect(await detail.locator(".col-main").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    if (width < 768) {
      // Full-screen on a phone: the title shares the close button's line instead of sitting under
      // an empty strip that holds only the button, and stays clear of it.
      await detail.evaluate((element) => { element.scrollTop = 0; });
      const close = (await detail.locator(".close-btn").boundingBox())!;
      const title = await detail.locator(".card-title").evaluate((element) => {
        const box = element.getBoundingClientRect();
        return { top: box.top, textRight: box.right - parseFloat(getComputedStyle(element).paddingRight) };
      });
      expect(title.top).toBeLessThan(close.y + close.height);
      expect(title.textRight).toBeLessThanOrEqual(close.x);
    }
    await detail.locator(".attach-row").scrollIntoViewIfNeeded();
    await detail.locator(".label-add-btn").click();
    await insideViewport(detail.locator(".lp-panel"));
    await page.keyboard.press("Escape");
    await detail.locator(".description-viewer-wrap").click();
    const editor = detail.locator("k-description-editor");
    await expect(editor.locator(".tiptap")).toBeVisible();
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  }
});
