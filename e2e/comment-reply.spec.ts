import { expect, test } from "./support/fixtures";
import { createCard, openBoard, openCard } from "./support/ui";

test("replying to a comment puts the caret below the quote so the reply can be typed straight away", async ({ page, signIn, pageAs, uniqueName }) => {
  const title = uniqueName("E2E reply card");
  await signIn(page, "amelia");
  await openBoard(page, "Platform Delivery");
  await createCard(page, title);

  // Reply is offered only on someone else's comment, so a second member posts the original.
  const author = await pageAs("marcus");
  await openBoard(author, "Platform Delivery");
  const authorDetail = await openCard(author, title);
  await authorDetail.getByRole("button", { name: /Comments/ }).click();
  await authorDetail.getByRole("button", { name: "Write a comment..." }).click();
  await authorDetail.locator("k-description-editor .tiptap[contenteditable='true']").fill("Original question");
  await authorDetail.getByRole("button", { name: "Send" }).click();
  await expect(authorDetail.locator(".comment").filter({ hasText: "Original question" })).toHaveCount(1);

  const detail = await openCard(page, title);
  await detail.getByRole("button", { name: /Comments/ }).click();
  const editor = detail.locator("k-description-editor .tiptap[contenteditable='true']");
  const original = detail.locator(".comment").filter({ hasText: "Original question" });
  await expect(original).toHaveCount(1);

  // Type without clicking into the composer: the caret must already be after the quote.
  await original.getByRole("button", { name: "Reply" }).click();
  await expect(editor.locator("blockquote")).toContainText("Original question");
  await expect(editor).toBeFocused();
  await page.keyboard.type("My reply");
  await expect(editor.locator("blockquote")).not.toContainText("My reply");
  await page.screenshot({ path: test.info().outputPath("comment-reply-composer.png") });
  await detail.getByRole("button", { name: "Send" }).click();

  const reply = detail.locator(".comment").filter({ hasText: "My reply" });
  await expect(reply).toHaveCount(1);
  await expect(reply.locator("blockquote")).toContainText("Original question");
  await expect(reply.locator("blockquote")).not.toContainText("My reply");
});
