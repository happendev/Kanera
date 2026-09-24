import { SEED_PASSWORD, users, webOrigin } from "./support/env";
import { expect, test } from "./support/fixtures";

// The only spec that signs in through the form; every other spec uses the API sign-in fixture.
test("password sign-in survives reload through the refresh cookie and log out ends the session", async ({ page }) => {
  await page.goto("/login");
  await page.locator("#email").fill(users.amelia.email);
  await page.locator("#password").fill(SEED_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("k-app-shell")).toBeVisible();

  // The access token lives only in memory, so this reload is signed in only if the httpOnly
  // refresh cookie reached /api/auth/refresh through the same-origin path rewrite.
  await page.reload();
  await expect(page.locator("k-app-shell")).toBeVisible();
  await expect(page.getByRole("button", { name: users.amelia.name })).toBeVisible();

  await page.getByRole("button", { name: users.amelia.name }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator("k-app-shell")).toHaveCount(0);
});

test("a wrong password is rejected without creating a session", async ({ page }) => {
  await page.goto("/login");
  await page.locator("#email").fill(users.amelia.email);
  await page.locator("#password").fill(`${SEED_PASSWORD}-wrong`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".error-banner")).toContainText("Invalid credentials");
  await expect(page).toHaveURL(`${webOrigin}/login`);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
});
