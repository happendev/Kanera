import type { APIResponse, Locator } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { openCard } from "./support/ui";

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

// Section extraction can lose direct-child sizing rules or leak drawer styles into nested editors
// and popovers. Exercise both layout modes and theme families, keeping geometry and screenshots.
test("card detail sections and nested controls retain their layout across themes and widths", async ({ page, apiAs, signIn, testWorkspace, uniqueName }, testInfo) => {
  test.setTimeout(180_000);
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

  const snapshots: Record<string, unknown> = {};
  const capture = async (name: string, root: Locator = detail) => {
    await page.mouse.move(0, 0);
    await page.screenshot({ path: testInfo.outputPath(`${name}.png`), animations: "disabled" });
    snapshots[name] = await root.evaluate((element) => {
      const properties = ["display", "position", "width", "height", "min-width", "min-height", "flex", "gap", "padding", "margin", "font-family", "font-size", "font-weight", "line-height", "color", "background-color", "border", "border-radius", "box-shadow", "overflow-x", "overflow-y", "align-items", "justify-content"];
      return [element, ...Array.from(element.querySelectorAll("*"))]
        .filter((node) => !node.tagName.toLowerCase().startsWith("k-card-detail-"))
        .map((node) => ({ tag: node.tagName, class: node.getAttribute("class") ?? "", styles: Object.fromEntries(properties.map((property) => [property, getComputedStyle(node).getPropertyValue(property)])) }));
    });
  };
  const insideViewport = async (target: Locator) => {
    await expect(target).toBeVisible();
    const box = (await target.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.y).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  };
  for (const [theme, width, modal] of [
    ["light", 1440, false], ["dark", 1440, false], ["paper", 1440, false], ["carbon", 1440, false],
    ["light", 1440, true], ["dark", 1440, true],
    ["light", 768, true], ["dark", 768, true], ["light", 390, true], ["dark", 390, true],
  ] as const) {
    const name = `${theme}-${width}-${modal ? "modal" : "panel"}`;
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((next) => window.dispatchEvent(new StorageEvent("storage", { key: "kanera-theme", newValue: next })), theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    if (width >= 1024 && (await detail.getAttribute("class"))!.includes("mode-modal") !== modal) await detail.locator(".layout-mode-btn").click();
    await detail.locator(".col-main").evaluate((element) => { element.scrollTop = 0; });
    await insideViewport(detail);
    await expect(detail.locator(".description-viewer-wrap").locator("..")).toHaveCSS("flex", "0 0 auto");
    // The activity component owns these styles. Drawer section indentation/badge borders must
    // not cross its rendering boundary when the shared section stylesheet is loaded.
    await expect(detail.locator("k-card-activity .comment-form")).toHaveCSS("margin-left", "0px");
    await expect(detail.locator("k-card-activity .feed")).toHaveCSS("margin-left", "0px");
    await expect(detail.locator("k-card-activity .section-label .count")).toHaveCSS("border-top-width", "0px");
    expect(await detail.locator(".col-main").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await capture(`${name}-top`);
    await detail.locator(".attach-row").scrollIntoViewIfNeeded();
    await capture(`${name}-sections`);
    await detail.locator(".label-add-btn").click();
    await insideViewport(detail.locator(".lp-panel"));
    await capture(`${name}-labels`, detail.locator("k-label-picker"));
    await page.keyboard.press("Escape");
    await detail.locator(".description-viewer-wrap").click();
    const editor = detail.locator("k-description-editor");
    await expect(editor.locator(".tiptap")).toBeVisible();
    await capture(`${name}-editor`, editor);
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  await testInfo.attach("computed-styles.json", { body: JSON.stringify(snapshots), contentType: "application/json" });
});
