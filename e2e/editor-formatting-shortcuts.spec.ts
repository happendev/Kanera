import type { Locator } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { expectBoardLoaded, openCard } from "./support/ui";

async function selectWord(editor: Locator, word: string) {
  await editor.focus();
  await editor.evaluate(async (element, selectedWord) => {
    // Let focus restoration finish, then notify the editor of the native selection.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const start = node.textContent?.indexOf(selectedWord) ?? -1;
      if (start < 0) continue;
      window.getSelection()!.setBaseAndExtent(node, start, node, start + selectedWord.length);
      document.dispatchEvent(new Event("selectionchange"));
      return;
    }
    throw new Error(`Editor word not found: ${selectedWord}`);
  }, word);
}

async function expectSavedFormatting(viewer: Locator) {
  await expect(viewer.locator("code")).toHaveText("code");
  await expect(viewer.locator("a")).toHaveText("link");
  await expect(viewer.locator("a")).toHaveAttribute("href", "https://example.com/docs");
  await expect(viewer.locator("del")).toHaveText("retired");
  await expect(viewer.locator("strong")).toHaveCount(0);
}

test("editor shortcuts preserve selection, focus and formatting after save/reload", async ({ page, signIn, apiAs, uniqueName, testWorkspace }, testInfo) => {
  const api = await apiAs("amelia");
  const title = uniqueName("Editor shortcuts");
  const { boardId, boardName, lists } = testWorkspace;
  const response = await api.post(`/api/boards/${boardId}/lists/${lists.get("Backlog")!}/cards`, { data: { title } });
  expect(response.ok(), await response.text()).toBe(true);
  await signIn(page, "amelia", `/b/${boardId}`);
  await expectBoardLoaded(page, boardName);
  const detail = await openCard(page, title);
  await detail.locator(".description-viewer-wrap").click();
  const editor = detail.locator("k-description-editor");
  const document = editor.locator(".tiptap");
  await document.fill("code link retired plain");

  await selectWord(document, "code");
  await page.keyboard.press("Control+Backquote");
  await expect(document.locator("code")).toHaveText("code");
  await selectWord(document, "link");
  await page.keyboard.press("Control+k");
  const linkInput = editor.locator(".de-link-input");
  await expect(linkInput).toBeFocused();
  await expect(page.locator("k-global-search-overlay")).toHaveCount(0);
  await linkInput.fill("https://example.com/docs");
  await linkInput.press("Enter");
  await expect(document).toBeFocused();

  await selectWord(document, "retired");
  await page.keyboard.press("Control+Shift+s");
  await selectWord(document, "plain");
  await page.keyboard.press("Control+b");
  await expect(document.locator("strong")).toHaveText("plain");
  await page.keyboard.press("Control+Backslash");
  await expect(document.locator("strong")).toHaveCount(0);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expectSavedFormatting(detail.locator(".description-viewer-wrap"));

  await page.goto(`/b/${boardId}`);
  await expectBoardLoaded(page, boardName);
  const reopened = (await openCard(page, title)).locator(".description-viewer-wrap");
  await expectSavedFormatting(reopened);
  await page.screenshot({ path: testInfo.outputPath("editor-formatting-desktop.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await reopened.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("editor-formatting-phone.png"), animations: "disabled" });
});
