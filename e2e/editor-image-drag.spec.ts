import { readFileSync } from "node:fs";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { expectBoardLoaded, openCard } from "./support/ui";

const imageFiles = ["access-review-symbol.png", "access-review-evidence.jpg"].map((name) => ({
  name,
  mimeType: name.endsWith("png") ? "image/png" : "image/jpeg",
  buffer: readFileSync(path.join(__dirname, "..", "dev-db-seed-content/attachments/images", name)),
}));

async function imageSources(container: Locator): Promise<string[]> {
  // Viewers refresh signed query parameters and omit download names; the storage path identifies
  // the original attachment and exposes any accidental re-upload.
  return container.locator("img").evaluateAll((images) => images.map((image) => new URL(image.getAttribute("src") ?? "", location.href).pathname));
}

async function expectImages(container: Locator, sources: string[]) {
  await expect.poll(() => imageSources(container)).toEqual(sources);
}

async function insertImages(editor: Locator) {
  // Keep both images and the drop position visible without depending on the fixture dimensions.
  await editor.page().addStyleTag({ content: "k-description-editor .tiptap img { max-height: 100px !important; width: auto !important; }" });
  for (const [index, image] of imageFiles.entries()) {
    await editor.locator("input[type=file]").setInputFiles(image);
    await expect(editor.locator(".tiptap img")).toHaveCount(index + 1);
    await expect(editor.locator(".de-uploading")).toHaveCount(0);
  }
  return imageSources(editor.locator(".tiptap"));
}

async function moveImageWithFilePayload(editor: Locator) {
  await editor.scrollIntoViewIfNeeded();
  // Native image drags can carry a file alongside ProseMirror's HTML. Explicitly retain that file
  // so this regression also runs on Chromium versions that clear it after dragstart.
  await editor.locator(".tiptap").evaluate((element, encoded) => {
    const source = element.querySelector("img")!;
    const target = element.querySelector("p:last-child")!;
    const transfer = new DataTransfer();
    const start = source.getBoundingClientRect();
    source.dispatchEvent(new DragEvent("dragstart", {
      bubbles: true, cancelable: true, dataTransfer: transfer,
      clientX: start.x + 10, clientY: start.y + 10,
    }));
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    transfer.items.add(new File([bytes], "dragged-image.png", { type: "image/png" }));
    const end = target.getBoundingClientRect();
    for (const type of ["dragover", "drop"]) {
      target.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, dataTransfer: transfer,
        clientX: end.x + 10, clientY: end.y + end.height / 2,
      }));
    }
    element.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: transfer }));
  }, imageFiles[0]!.buffer.toString("base64"));
}

for (const surface of ["description", "comment", "note", "scratchpad"] as const) {
  test(`${surface} image drag moves the original without another upload`, async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
    const api = await apiAs("amelia");
    const name = uniqueName(`Image reorder ${surface}`);
    const created = await api.post("/api/workspaces", {
      data: { name, initialBoard: { name }, listNames: ["To do", "Done"], customFields: [] },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const workspace = await created.json() as { id: string; initialBoard: { id: string } };
    const boardId = workspace.initialBoard.id;
    let scratchpadId: string | undefined;
    try {
      let url = `/b/${boardId}`;
      if (surface === "note") {
        const response = await api.post(`/api/boards/${boardId}/notes`, { data: { scope: "team", title: name } });
        expect(response.ok(), await response.text()).toBe(true);
        const note = await response.json() as { id: string };
        url += `?view=notes&noteId=${note.id}`;
      } else if (surface === "scratchpad") {
        const response = await api.post("/api/scratchpad/notes", { data: { title: name } });
        expect(response.ok(), await response.text()).toBe(true);
        scratchpadId = (await response.json() as { id: string }).id;
        url = "/scratchpad";
      } else {
        const board = await (await api.get(`/api/boards/${boardId}?includeCards=false`)).json() as { lists: { id: string }[] };
        const response = await api.post(`/api/boards/${boardId}/lists/${board.lists[0]!.id}/cards`, { data: { title: name } });
        expect(response.ok(), await response.text()).toBe(true);
      }
      await signIn(page, "amelia");
      const open = async () => {
        await page.goto(url);
        if (surface === "note") return page.locator("k-note-editor .ne-viewer");
        if (surface === "scratchpad") {
          await page.locator(".page-trigger").click();
          await page.locator(".page-list-item").filter({ hasText: name }).click();
          await expect(page.locator(".page-trigger-label")).toHaveText(name);
          return page.locator("k-scratchpad-panel .tiptap");
        }
        await expectBoardLoaded(page, name);
        const detail = await openCard(page, name);
        return surface === "description"
          ? detail.locator(".description-viewer-wrap")
          : detail.locator(".comment k-description-viewer");
      };
      const viewer = await open();
      if (surface === "comment") await page.getByRole("button", { name: "Write a comment..." }).click();
      else if (surface !== "scratchpad") await viewer.click();
      const editor = page.locator("k-description-editor:visible");
      let uploads = 0;
      page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/attachments")) uploads++;
      });
      const sources = await insertImages(editor);
      // ProseMirror groups edits within 500ms. Let the uploads' history group close so undo checks
      // the drag by itself, rather than also undoing the just-finished uploads.
      await page.waitForTimeout(600);
      const document = editor.locator(".tiptap");
      const reordered = [...sources].reverse();
      if (surface === "description") {
        await document.locator("img").first().dragTo(document.locator(":scope > p").last());
        await expectImages(document, reordered);
        await document.press("Control+z");
        await expectImages(document, sources);
      }
      await moveImageWithFilePayload(editor);
      await expectImages(document, reordered);
      await expect(editor.locator(".de-uploading")).toHaveCount(0);
      expect(uploads).toBe(2);
      await document.press("Control+z");
      await expectImages(document, sources);
      await document.press("Control+Shift+z");
      await expectImages(document, reordered);
      await page.screenshot({ path: testInfo.outputPath(`${surface}-images-desktop.png`), animations: "disabled" });
      await page.setViewportSize({ width: 390, height: 844 });
      if (surface === "comment") await page.locator(".col-tabs").getByRole("button", { name: /Activity/ }).click();
      await editor.scrollIntoViewIfNeeded();
      await expectImages(document, reordered);
      await page.screenshot({ path: testInfo.outputPath(`${surface}-images-phone.png`), animations: "disabled" });
      await page.setViewportSize({ width: 1440, height: 900 });
      if (surface === "scratchpad") {
        await expect.poll(async () => {
          const notes = await (await api.get("/api/scratchpad/notes")).json() as { id: string; content: string }[];
          const content = notes.find((note) => note.id === scratchpadId)?.content ?? "";
          return Array.from(content.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g), (match) => new URL(match[1]!, page.url()).pathname);
        }).toEqual(reordered);
      } else {
        await editor.getByRole("button", { name: surface === "comment" ? "Send" : "Save", exact: true }).click();
        await expectImages(viewer, reordered);
      }
      await expectImages(await open(), reordered);
      expect(uploads).toBe(2);
    } finally {
      // Leave the mounted editor before removing its backing data.
      await page.goto("/");
      if (scratchpadId) expect((await api.delete(`/api/scratchpad/notes/${scratchpadId}`)).ok()).toBe(true);
      expect((await api.delete(`/api/workspaces/${workspace.id}`, { data: { confirmationName: name } })).ok()).toBe(true);
    }
  });
}
