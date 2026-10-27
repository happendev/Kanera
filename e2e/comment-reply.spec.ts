import { expect, test } from "./support/fixtures";
import { createCard, expectCardTileMounted, openBoard, openCard } from "./support/ui";

for (const width of [1280, 390]) {
  test(`replying to a comment puts the caret below the quote at ${width}px`, async ({ page, signIn, pageAs, uniqueName, testWorkspace }) => {
    await page.setViewportSize({ width, height: 900 });
    const title = uniqueName("E2E reply card");
    await signIn(page, "amelia");
    await openBoard(page, testWorkspace.boardName);
    await createCard(page, title);

    // Reply is offered only on someone else's comment, so a second member posts the original.
    const author = await pageAs("marcus");
    await openBoard(author, testWorkspace.boardName);
    await expectCardTileMounted(author, title);
    const authorDetail = await openCard(author, title);
    await authorDetail.getByRole("button", { name: /Comments/ }).click();
    await authorDetail.getByRole("button", { name: "Write a comment..." }).click();
    await authorDetail.locator("k-description-editor .tiptap[contenteditable='true']").fill("Original question");
    await authorDetail.getByRole("button", { name: "Send" }).click();
    await expect(authorDetail.locator(".comment").filter({ hasText: "Original question" })).toHaveCount(1);

    const detail = await openCard(page, title);
    const activityTab = detail.locator(".tab-btn").filter({ hasText: "Activity" });
    if (await activityTab.isVisible()) await activityTab.click();
    await detail.getByRole("button", { name: "Comments", exact: true }).click();
    const editor = detail.locator("k-description-editor .tiptap[contenteditable='true']");
    const original = detail.locator(".comment").filter({ hasText: "Original question" });
    await expect(original).toHaveCount(1);

    // Type without clicking into the composer: the caret must already be after the quote.
    await original.getByRole("button", { name: "Reply" }).click();
    await expect(editor.locator("blockquote")).toContainText("Original question");
    await expect(editor).toBeFocused();
    await page.keyboard.type("My reply");
    await expect(editor.locator("blockquote")).not.toContainText("My reply");
    await expect(editor.locator(":scope > blockquote + p")).toHaveText("My reply");
    await page.screenshot({ path: test.info().outputPath("comment-reply-composer.png") });
    await detail.getByRole("button", { name: "Send" }).click();

    const reply = detail.locator(".comment").filter({ hasText: "My reply" });
    await expect(reply).toHaveCount(1);
    await expect(reply.locator("blockquote")).toContainText("Original question");
    await expect(reply.locator("blockquote")).not.toContainText("My reply");

    // Reply into an empty, already-open composer must also land below the quote.
    await detail.getByRole("button", { name: "Write a comment..." }).click();
    await expect(editor).toBeFocused();
    await original.getByRole("button", { name: "Reply" }).click();
    await expect(editor).toBeFocused();
    await page.keyboard.type("Empty composer reply");
    await expect(editor.locator(":scope > blockquote + p")).toHaveText("Empty composer reply");
    await page.screenshot({ path: test.info().outputPath("comment-reply-existing-composer.png") });
    await detail.getByRole("button", { name: "Cancel", exact: true }).click();

    // An already-open composer must retain its draft after the quote and focus its end.
    await detail.getByRole("button", { name: "Write a comment..." }).click();
    await editor.fill("Existing draft");
    await original.getByRole("button", { name: "Reply" }).click();
    await expect(editor).toBeFocused();
    await page.keyboard.type(" continued");
    await expect(editor.locator(":scope > blockquote + p")).toHaveText("Existing draft continued");
    await detail.getByRole("button", { name: "Cancel", exact: true }).click();
  });
}
