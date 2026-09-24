import { expect, test } from "./support/fixtures";
import { createCard, openBoard, openCard } from "./support/ui";

test("a comment mention creates a durable unread notification with a working card link and read action", async ({ page, signIn, pageAs, uniqueName }) => {
  const title = uniqueName("E2E mention card");
  await signIn(page, "amelia");
  const recipient = await pageAs("marcus");
  await openBoard(page, "Platform Delivery");
  await createCard(page, title);
  const detail = await openCard(page, title);
  await detail.getByRole("button", { name: /Comments/ }).click();
  await detail.getByRole("button", { name: "Write a comment..." }).click();
  const editor = detail.locator("k-description-editor .tiptap[contenteditable='true']");
  await editor.fill("Please review @Marc");
  const option = detail.locator(".de-mention-option").filter({ hasText: "Marcus Cole" });
  await expect(option).toBeVisible();
  await option.click();
  await editor.press("End");
  await editor.pressSequentially(" when you can.");
  await detail.getByRole("button", { name: "Send" }).click();
  await expect(detail.locator(".comment").filter({ hasText: "Please review" })).toHaveCount(1);

  const notification = recipient.locator(".notif-item").filter({ hasText: title });
  const readState = recipient.getByRole("group", { name: "Read state" });
  await recipient.getByRole("button", { name: /^Notifications/ }).click();
  await expect(notification).toBeVisible();
  await expect(notification).not.toHaveClass(/is-read/);
  await expect(notification.getByRole("link", { name: `Open card ${title}` })).toHaveAttribute("href", /\/(?:c|b)\//);

  await recipient.reload();
  await recipient.getByRole("button", { name: /^Notifications/ }).click();
  await expect(notification).not.toHaveClass(/is-read/);
  await readState.getByRole("button", { name: "All" }).click();
  await notification.getByRole("button", { name: "Mark as read" }).click();
  await expect(notification).toHaveClass(/is-read/);

  await recipient.reload();
  await recipient.getByRole("button", { name: /^Notifications/ }).click();
  await readState.getByRole("button", { name: "All" }).click();
  await expect(notification).toHaveClass(/is-read/);
  await notification.getByRole("link", { name: `Open card ${title}` }).click();
  await expect(recipient.getByRole("dialog", { name: `Card detail: ${title}` })).toBeVisible();
});
