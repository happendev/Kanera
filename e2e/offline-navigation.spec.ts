import { test, expect } from "./support/fixtures";
import { SocketLink } from "./support/socket";
import { openBoard } from "./support/ui";

test("offline navigation disables server actions and restores them on reconnect", async ({ page, signIn }, testInfo) => {
  const socket = await SocketLink.install(page.context());
  await signIn(page, "amelia");
  await openBoard(page, "Platform Delivery");
  await expect.poll(() => socket.connectionCount).toBeGreaterThan(0);
  // The production service worker prefetches JS; this dev-server suite must warm lazy help first.
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /^Up next/ }).first().click();
  await expect(page.getByRole("dialog", { name: "Up next", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Up next", exact: true })).toHaveCount(0);
  const searchButton = page.getByRole("button", { name: "Find content", exact: true });
  await searchButton.click();
  const search = page.getByRole("dialog", { name: "Search", exact: true });
  await expect(search).toBeVisible();

  // Cut the live socket too: browser offline emulation alone can leave realtime connected.
  await socket.cut();
  await expect.poll(() => socket.refusedAttempts).toBeGreaterThan(0);
  await expect(searchButton).toBeDisabled();
  await page.context().setOffline(true);
  try {
    await expect(searchButton).toBeDisabled();
    await expect(search).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Up next/ })).toBeEnabled();
    await page.keyboard.press("u");
    await expect(page.getByRole("dialog", { name: "Up next", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Up next", exact: true })).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+k");
    await expect(search).toHaveCount(0);
    const url = page.url();
    await page.keyboard.press("g");
    await page.keyboard.press("s");
    await expect(page).toHaveURL(url);

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const sidebar = page.locator("aside.sidebar");
      if (width === 390) await page.keyboard.press("[");
      await expect(searchButton).toBeVisible();
      await expect(searchButton).toBeDisabled();
      await expect(sidebar.getByRole("button", { name: "New workspace", exact: true })).toBeDisabled();
      await expect(sidebar.getByRole("button", { name: "New standalone board", exact: true })).toBeDisabled();
      const boardLinks = sidebar.locator("a.board-link.cdk-drag");
      expect(await boardLinks.count()).toBeGreaterThan(0);
      for (const link of await boardLinks.all()) {
        await expect(link).toHaveClass(/cdk-drag-disabled/);
        await expect(link).toHaveAttribute("href", /^\/b\//);
      }
      const settings = sidebar.locator("a.ws-settings");
      expect(await settings.count()).toBeGreaterThan(0);
      for (const link of await settings.all()) {
        await expect(link).toHaveAttribute("aria-disabled", "true");
        await expect(link).not.toHaveAttribute("href");
        await expect(link).toHaveAttribute("tabindex", "-1");
      }
      await settings.first().dispatchEvent("contextmenu");
      await expect(page.locator(".nav-context-menu")).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`offline-navigation-${width}.png`) });
      await sidebar.locator(".user-trigger").click();
      const menu = page.locator(".user-popover");
      await expect(menu.locator(".organisation-trigger")).toBeDisabled();
      for (const name of ["Profile settings", "Notifications", "Manage users", "Organisation settings", "How to install Kanera", "Help & docs"]) {
        const item = menu.getByRole("menuitem", { name });
        await expect(item).toBeDisabled();
        await expect(item).not.toHaveAttribute("href");
        await expect(item).toHaveAttribute("tabindex", "-1");
      }
      await expect(menu.getByRole("menuitem", { name: "Log out" })).toBeEnabled();
      await expect(menu.getByRole("menuitem", { name: "Keyboard shortcuts" })).toBeEnabled();
      await menu.getByRole("menuitem", { name: "Keyboard shortcuts" }).focus();
      await page.keyboard.press("ArrowDown");
      await expect(menu.getByRole("menuitem", { name: "Log out" })).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(menu.getByRole("menuitem", { name: "Keyboard shortcuts" })).toBeFocused();
      // Even a synthetic activation must not close the menu or navigate.
      await menu.getByRole("menuitem", { name: "Profile settings" }).dispatchEvent("click");
      await expect(menu).toBeVisible();
      await expect(page).toHaveURL(url);
      await page.screenshot({ path: testInfo.outputPath(`offline-account-${width}.png`) });
      await menu.getByRole("menuitem", { name: "Keyboard shortcuts" }).click();
      await expect(page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    }

    await page.setViewportSize({ width: 1280, height: 900 });
    if (await page.locator("aside.sidebar").evaluate((el) => el.classList.contains("collapsed"))) {
      await page.keyboard.press("[");
    }
    // Compact sidebar settings must also lose their destination.
    await page.keyboard.press("[");
    const compactSettings = page.locator("aside.sidebar a.ws-icon-link");
    expect(await compactSettings.count()).toBeGreaterThan(0);
    await expect(compactSettings.first()).toHaveAttribute("aria-disabled", "true");
    await expect(compactSettings.first()).not.toHaveAttribute("href");
    await page.keyboard.press("[");
  } finally {
    socket.restore();
    await page.context().setOffline(false);
  }
  await expect(searchButton).toBeEnabled();
  await expect(page.locator("aside.sidebar a.board-link.cdk-drag").first()).not.toHaveClass(/cdk-drag-disabled/);
  await expect(page.locator("aside.sidebar a.ws-settings").first()).toHaveAttribute("href", /settings$/);
  await page.locator(".user-trigger").click();
  await expect(page.locator(".organisation-trigger")).toBeEnabled();
  const profile = page.getByRole("menuitem", { name: "Profile settings" });
  await expect(profile).toBeEnabled();
  await expect(profile).toHaveAttribute("href", "/settings");
  await page.keyboard.press("Escape");
  await searchButton.click();
  await expect(search).toBeVisible();
});
