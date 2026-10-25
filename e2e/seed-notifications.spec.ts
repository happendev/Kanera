import { expect, test } from "./support/fixtures";

// A reset must produce an inbox with usable history, without a separate screenshot setup script.
test("the demo seed opens a dated inbox with overdue work and a complete conversation", async ({ page, apiAs, signIn }, testInfo) => {
  const api = await apiAs("amelia");
  const response = await api.get("/api/notifications/unread?limit=100");
  expect(response.ok()).toBe(true);
  const { items } = await response.json() as { items: {
    id: string; cardTitle: string; reason: string; createdAt: string; commentBody: string | null;
    activity: { entityType: string; action: string } | null;
  }[] };
  const conversation = items.filter(item => item.cardTitle === "Build the launch measurement sheet");
  expect(conversation).toHaveLength(3);
  expect(conversation.map(item => item.activity?.action).sort()).toEqual(["assignees:set", "created", "customFieldValue:set"]);
  expect(conversation.find(item => item.activity?.entityType === "comment")?.commentBody).toContain("Please advise if the campaign setup is correct");
  expect(items.filter(item => item.reason === "overdue").length).toBeGreaterThanOrEqual(2);
  expect(new Set(items.map(item => item.createdAt.slice(0, 10))).size).toBeGreaterThanOrEqual(2);
  const now = Date.now();
  for (const item of items) {
    expect(now - new Date(item.createdAt).getTime(), item.cardTitle).toBeGreaterThan(60 * 60_000);
    if (item.activity?.entityType === "comment") expect(item.commentBody?.trim(), item.cardTitle).toBeTruthy();
  }
  await testInfo.attach("seeded-notification-history", { body: JSON.stringify(items, null, 2), contentType: "application/json" });
  await signIn(page, "amelia");
  await page.getByRole("button", { name: /^Notifications/ }).click();
  const drawer = page.getByRole("dialog", { name: "Notifications" });
  await expect(drawer.locator(".notif-comment-body").filter({ hasText: "Please advise if the campaign setup is correct" })).toBeVisible();
  await expect(drawer.locator(".notif-time").filter({ hasText: /just now/i })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("seed-notifications-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(".notif-time").filter({ hasText: /just now/i })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("seed-notifications-phone.png") });
});
