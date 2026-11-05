import { test, expect } from "./support/fixtures";

test("account settings routes survive reload and remain accessible on phones", async ({ page, signIn }) => {
  await signIn(page, "priya");
  await page.goto("/settings/profile");
  await expect(page.getByRole("heading", { name: "Profile picture" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Card keys" })).toHaveCount(0);

  await page.locator('nav a[href="/settings/account-security"]').click();
  await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Change password" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Set up authenticator" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Change password" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.locator('nav a[href="/settings/preferences"]').click();
  await expect(page.getByRole("heading", { name: "Card keys" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Scratchpad" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Change password" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Card keys" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
