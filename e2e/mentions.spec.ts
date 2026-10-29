import { expect, test } from "./support/scenario";
import { createCard, openBoard, openCard } from "./support/ui";

test("a comment mention creates a durable unread notification with a working card link and read action", async ({ page, signIn, pageAs, uniqueName }, testInfo) => {
  const title = uniqueName("E2E mention card");
  await signIn(page, "amelia");
  const recipient = await pageAs("marcus");
  await openBoard(page, "E2E primary board");
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
  // This session never opens its inbox, so it must reconcile IDs it has not loaded.
  const sibling = await pageAs("marcus");
  const siblingBadge = sibling.getByRole("button", { name: /^Notifications/ }).locator(".utility-badge");
  await expect(siblingBadge).toHaveText("1");
  // Finish the feed switch before measuring the read action's reconciliation burst.
  await recipient.waitForTimeout(1_000);
  const reads: string[] = [];
  recipient.on("request", (request) => {
    if (request.method() === "GET" && new URL(request.url()).pathname.startsWith("/api/notifications")) {
      reads.push(new URL(request.url()).pathname);
    }
  });
  await notification.getByRole("button", { name: "Mark as read" }).click();
  await expect(notification).toHaveClass(/is-read/);
  await expect.poll(() => reads.filter((path) => path.endsWith("/agent-counts")).length).toBeGreaterThan(0);
  // Include delayed socket echoes and debounced reconciliation in the negative assertion.
  await recipient.waitForTimeout(1_000);
  for (const endpoint of ["unread-count", "board-unread-counts", "card-unread-counts", "org-unread-counts", "agent-counts", "group-counts"]) {
    expect(reads.filter((path) => path.endsWith(`/${endpoint}`)), endpoint).toHaveLength(1);
  }
  expect(reads.filter((path) => path.endsWith("/users"))).toHaveLength(0);
  expect(reads.filter((path) => path === "/api/notifications")).toHaveLength(1);
  await expect(siblingBadge).toHaveCount(0);
  await recipient.screenshot({ animations: "disabled", path: testInfo.outputPath("notification-read-desktop.png") });
  await recipient.setViewportSize({ width: 390, height: 844 });
  await expect(recipient.getByRole("dialog", { name: "Notifications", exact: true })).toHaveCSS("left", "52px");
  await recipient.screenshot({ animations: "disabled", path: testInfo.outputPath("notification-read-phone.png") });

  await recipient.reload();
  await recipient.getByRole("button", { name: /^Notifications/ }).click();
  await readState.getByRole("button", { name: "All" }).click();
  await expect(notification).toHaveClass(/is-read/);
  await notification.getByRole("link", { name: `Open card ${title}` }).click();
  await expect(recipient.getByRole("dialog", { name: `Card detail: ${title}` })).toBeVisible();
});
