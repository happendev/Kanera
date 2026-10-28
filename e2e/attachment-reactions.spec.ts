import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./support/scenario";
import { createCard, openBoard, openCard } from "./support/ui";

const screenshot = readFileSync(path.join(__dirname, "fixtures/sample.png"));

test("a teammate can thumbs-up and comment on an uploaded screenshot, and the uploader is told live", async ({ page, signIn, pageAs, uniqueName }) => {
  const title = uniqueName("E2E screenshot feedback card");
  const fileName = "e2e-built-it.png";
  await signIn(page, "amelia");
  await openBoard(page, "E2E primary board");
  await createCard(page, title);
  const uploaderDetail = await openCard(page, title);

  // The reviewer has the card open before the upload, so the row and its actions must arrive live.
  const reviewer = await pageAs("marcus");
  await openBoard(reviewer, "E2E primary board");
  const reviewerDetail = await openCard(reviewer, title);

  await uploaderDetail.locator(".attach-upload input[type=file]").setInputFiles({ name: fileName, mimeType: "image/png", buffer: screenshot });

  const uploaderRow = uploaderDetail.locator(".activity-item").filter({ hasText: fileName });
  await expect(uploaderRow.locator(".activity-attachment-preview img")).toBeVisible();
  // Nobody reacts to their own upload, but they can still start a comment about it.
  await expect(uploaderRow.locator(".activity-attachment-actions .reaction-add")).toHaveCount(0);
  await expect(uploaderRow.getByRole("button", { name: "Comment" })).toBeVisible();

  const reviewerRow = reviewerDetail.locator(".activity-item").filter({ hasText: fileName });
  // The uploader's second session keeps the inbox open: the thumbs-up must arrive there live.
  const uploaderInbox = await pageAs("amelia");
  await uploaderInbox.getByRole("button", { name: /^Notifications/ }).click();
  // The uploader's other session has this card open, which marks its notifications read on arrival,
  // so look in All rather than Unread.
  await uploaderInbox.getByRole("group", { name: "Read state" }).getByRole("button", { name: "All", exact: true }).click();
  const thumbsUpNotification = uploaderInbox.locator(".notif-item").filter({ hasText: title }).filter({ hasText: `gave ${fileName} a thumbs-up` });

  await reviewerRow.locator(".activity-attachment-actions .reaction-add").click();
  await expect(reviewerRow.locator(".reaction-chip.is-active")).toContainText("1");

  // Cross-process realtime: the uploader's open card picks up the reaction without a reload.
  const uploaderChip = uploaderRow.locator(".activity-attachment-actions .reaction-chip");
  await expect(uploaderChip).toContainText("1");
  await expect(uploaderChip).not.toHaveClass(/is-active/);
  await expect(thumbsUpNotification).toBeVisible();
  await uploaderInbox.screenshot({ path: test.info().outputPath("thumbs-up-notification.png") });

  // "Comment" quotes the screenshot itself and mentions the uploader, caret ready below the quote.
  await reviewerRow.getByRole("button", { name: "Comment" }).click();
  const editor = reviewerDetail.locator("k-description-editor .tiptap[contenteditable='true']");
  await expect(editor.locator(`blockquote img[alt="${fileName}"]`)).toBeVisible();
  await expect(editor.locator("blockquote")).toContainText("Amelia");
  await expect(editor).toBeFocused();
  await reviewer.keyboard.type("Looks great, ship it");
  await reviewerDetail.getByRole("button", { name: "Send" }).click();
  const uploaderComment = uploaderDetail.locator(".comment").filter({ hasText: "Looks great, ship it" });
  await expect(uploaderComment.locator(`blockquote img[alt="${fileName}"]`)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("attachment-reactions.png") });

  // Persisted, not just echoed: a reload still shows the reviewer's reaction as theirs.
  await reviewer.reload();
  const reopened = reviewer.getByRole("dialog", { name: `Card detail: ${title}` });
  const reopenedChip = reopened.locator(".activity-item").filter({ hasText: fileName }).locator(".reaction-chip.is-active");
  await expect(reopenedChip).toContainText("1");

  // Un-reacting takes the notification back, so nobody opens a card for a like that is gone.
  await reopenedChip.click();
  await expect(uploaderChip).toHaveCount(0);
  await expect(thumbsUpNotification).toHaveCount(0);
});
