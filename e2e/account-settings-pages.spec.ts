import { test, expect } from "./support/fixtures";

for (const user of ["priya", "amelia"] as const) {
  test(`account settings separates profile, security and preferences for ${user}`, async ({ page, signIn }, testInfo) => {
    await signIn(page, user);
    await page.goto("/settings/profile");
    await expect(page.getByRole("heading", { name: "Profile picture" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Card keys" })).toHaveCount(0);

    await page.locator('nav a[href="/settings/account-security"]').click();
    await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Change password" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Set up authenticator" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("security-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Change password" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("security-phone.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await page.locator('nav a[href="/settings/preferences"]').click();
    await expect(page.getByRole("heading", { name: "Card keys" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Learn more about card keys" })).toHaveAttribute("href", "https://www.kanera.app/docs/cards#card-keys-and-links");
    await expect(page.getByRole("heading", { name: "Scratchpad" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Change password" })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Card keys" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("preferences-phone.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Card keys" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("preferences-desktop.png"), fullPage: true });
  });
}
