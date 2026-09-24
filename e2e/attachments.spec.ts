import { readFileSync } from "node:fs";
import path from "node:path";
import type { Download, Locator, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { createCard, openBoard, openCard } from "./support/ui";

// Product rule (CLAUDE.md): attachments behave the same in the description, comments, the
// attachment list and activity rows. Images, video, audio and PDFs open the shared lightbox; any
// format it cannot render downloads instead. One file per behaviour class runs through each surface.
const seedContent = path.join(__dirname, "..", "dev-db-seed-content", "attachments");
const fixtures = {
  image: { file: "images/access-review-symbol.png", mimeType: "image/png", ext: "png", opens: "image" },
  pdf: { file: "pdfs/api-rollout-plan.pdf", mimeType: "application/pdf", ext: "pdf", opens: "pdf" },
  docx: {
    file: "docx/release-readiness-template.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ext: "docx",
    opens: "download",
  },
} as const;
type Kind = keyof typeof fixtures;
const kinds = Object.keys(fixtures) as Kind[];

function upload(kind: Kind, surface: string) {
  const fixture = fixtures[kind];
  return {
    name: `e2e-${surface}-${kind}.${fixture.ext}`,
    mimeType: fixture.mimeType,
    buffer: readFileSync(path.join(seedContent, fixture.file)),
  };
}

async function expectLightbox(detail: Locator, kind: "image" | "pdf", open: () => Promise<void>) {
  const page = detail.page();
  await open();
  const lightbox = page.locator("k-image-lightbox");
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator(kind === "image" ? ".lb-img" : ".lb-pdf")).toBeVisible();
  // Escape belongs to the lightbox: it must not also close the card detail underneath it.
  await page.keyboard.press("Escape");
  await expect(lightbox).toHaveCount(0);
  // The panel animates out, so "visible" alone would pass mid-close; `closing` is set immediately.
  await expect(detail).toBeVisible();
  await expect(detail).not.toHaveClass(/\bclosing\b/);
}

/**
 * A download may start in the page (blob anchor from MediaDownloadService) or in a new tab (a plain
 * target=_blank link served with Content-Disposition); either satisfies "downloads", but the file
 * must keep its original name rather than the storage key.
 */
async function expectDownload(page: Page, fileName: string, trigger: () => Promise<void>) {
  const download = new Promise<Download>((resolve) => {
    page.once("download", resolve);
    page.context().once("page", (popup) => popup.once("download", resolve));
  });
  await trigger();
  const result = await Promise.race([
    download,
    page.waitForTimeout(15_000).then(() => {
      throw new Error(`no download started for ${fileName}`);
    }),
  ]);
  expect(result.suggestedFilename()).toBe(fileName);
  await expect(page.locator("k-image-lightbox")).toHaveCount(0);
}

async function expectBehaviour(detail: Locator, kind: Kind, fileName: string, target: Locator) {
  const opens = fixtures[kind].opens;
  if (opens === "download") await expectDownload(detail.page(), fileName, () => target.click());
  else await expectLightbox(detail, opens, () => target.click());
}

/** Uploads through an editor's attach input one file at a time, checking earlier inserts survive. */
async function insertIntoEditor(editor: Locator, files: { kind: Kind; name: string; mimeType: string; buffer: Buffer }[]) {
  const inserted = (file: (typeof files)[number]) =>
    file.kind === "image" ? editor.locator(".tiptap img") : editor.locator(".tiptap a").filter({ hasText: file.name });
  for (const [index, file] of files.entries()) {
    await editor.locator("input[type=file]").setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: file.buffer });
    for (const earlier of files.slice(0, index + 1)) await expect(inserted(earlier)).toHaveCount(1);
  }
}

test("attachment list and activity rows preview or download by file type", async ({ page, signIn, uniqueName }) => {
  const title = uniqueName("E2E attachment card");
  await signIn(page, "amelia");
  await openBoard(page, "Platform Delivery");
  await createCard(page, title);
  const detail = await openCard(page, title);

  const files = kinds.map((kind) => ({ kind, ...upload(kind, "list") }));
  await detail.locator(".attach-upload input[type=file]").setInputFiles(files.map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer })));
  for (const file of files) await expect(detail.locator("li.attach-row").filter({ hasText: file.name })).toHaveCount(1);

  for (const file of files) {
    const row = detail.locator("li.attach-row").filter({ hasText: file.name });
    await expectBehaviour(detail, file.kind, file.name, row.locator(".attach-thumb"));
    await expectBehaviour(detail, file.kind, file.name, row.locator("a.attach-name"));
  }

  for (const file of files) {
    const item = detail.locator(".activity-item").filter({ hasText: file.name });
    await expect(item).toHaveCount(1);
    const target = file.kind === "image" ? item.locator(".activity-attachment-preview img") : item.locator("a.activity-file-preview");
    await expectBehaviour(detail, file.kind, file.name, target);
  }

  // The rows come from realtime events; a reload proves they were persisted, not just echoed.
  await page.reload();
  const reopened = page.getByRole("dialog", { name: `Card detail: ${title}` });
  await expect(reopened).toBeVisible();
  for (const file of files) await expect(reopened.locator("li.attach-row").filter({ hasText: file.name })).toHaveCount(1);
});

test("description and comment attachments preview or download by file type", async ({ page, signIn, uniqueName }) => {
  const title = uniqueName("E2E inline attachment card");
  await signIn(page, "amelia");
  await openBoard(page, "Platform Delivery");
  await createCard(page, title);
  const detail = await openCard(page, title);

  // Description: each upload is inserted into the editor, then saved as markdown.
  const descriptionFiles = kinds.map((kind) => ({ kind, ...upload(kind, "description") }));
  await detail.locator(".description-viewer-wrap").click();
  const descriptionEditor = detail.locator("k-description-editor");
  await insertIntoEditor(descriptionEditor, descriptionFiles);
  await descriptionEditor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(descriptionEditor).toHaveCount(0);
  const description = detail.locator(".description-viewer-wrap");
  for (const file of descriptionFiles) {
    const target = file.kind === "image" ? description.locator("k-description-viewer img") : description.locator("a").filter({ hasText: file.name });
    await expectBehaviour(detail, file.kind, file.name, target);
  }

  // Comments use the compact editor with its own attach button and a Send action.
  const commentFiles = kinds.map((kind) => ({ kind, ...upload(kind, "comment") }));
  await detail.getByRole("button", { name: "Write a comment..." }).click();
  const commentEditor = detail.locator(".comment-form k-description-editor");
  await insertIntoEditor(commentEditor, commentFiles);
  await commentEditor.getByRole("button", { name: "Send", exact: true }).click();
  const comment = detail.locator(".comment").filter({ hasText: commentFiles[2]!.name });
  await expect(comment).toHaveCount(1);
  for (const file of commentFiles) {
    const target = file.kind === "image" ? comment.locator("k-description-viewer img") : comment.locator("a").filter({ hasText: file.name });
    await expectBehaviour(detail, file.kind, file.name, target);
  }

  // Inline uploads are real attachments too, labelled by where they were added.
  for (const file of [...descriptionFiles, ...commentFiles]) {
    await expect(detail.locator("li.attach-row").filter({ hasText: file.name })).toHaveCount(1);
  }
});
