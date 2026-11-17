import { TEST_PASSWORD, users, webOrigin } from "./support/env";
import { expect, test } from "./support/fixtures";

// The only spec that signs in through the form; every other spec uses the API sign-in fixture.
test("password sign-in survives reload through the refresh cookie and log out ends the session", async ({ page }) => {
  await page.goto("/login");
  await page.locator("#email").fill(users.amelia.email);
  await page.locator("#password").fill(TEST_PASSWORD);
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
  await page.locator("#password").fill(`${TEST_PASSWORD}-wrong`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".error-banner")).toContainText("Invalid credentials");
  await expect(page).toHaveURL(`${webOrigin}/login`);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
});

for (const reason of ["explicit", "rejected", "another tab"] as const) {
  test(`logout clears private browser data: ${reason}`, async ({ page, signIn }) => {
    await signIn(page, "amelia");
    await expect(page.locator("k-app-shell")).toBeVisible();
    await page.evaluate(async () => {
      localStorage.setItem("kanera:editor-drafts", JSON.stringify({ secret: "Private note" }));
      localStorage.setItem("kanera:card-composer-drafts", JSON.stringify({ secret: "Private card" }));
      localStorage.setItem("kanera:recent-boards:old-org", '["private-board"]');
      localStorage.setItem("kanera.view.filters:board:private-board", "private filter");
      sessionStorage.setItem("kanera.notes.selection:old-user:workspace:personal", "private-note");
      localStorage.setItem("unrelated-app", "preserved");
      localStorage.setItem("kanera-density", "compact");
      const cache = await caches.open("kanera-share-target-v1");
      await cache.put("/share-target-payload/private", new Response("Private share"));
      // Seed every actual store, including normalized note bodies and cache accounting.
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("kanera-offline");
        request.onerror = () => reject(request.error ?? new Error("Could not open offline database"));
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(Array.from(db.objectStoreNames), "readwrite");
          for (const name of Array.from(db.objectStoreNames)) tx.objectStore(name).put({ secret: "Private snapshot" }, "logout-test");
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error ?? new Error("Could not seed offline database"));
        };
      });
    });

    if (reason === "rejected") {
      await page.context().clearCookies();
      await page.reload();
    } else if (reason === "another tab") {
      const other = await page.context().newPage();
      await other.goto("/");
      await expect(other.locator("k-app-shell")).toBeVisible();
      await other.getByRole("button", { name: users.amelia.name }).click();
      await other.getByRole("menuitem", { name: "Log out" }).click();
      await expect(other).toHaveURL(/\/login/);
      await other.close();
    } else {
      await page.getByRole("button", { name: users.amelia.name }).click();
      await page.getByRole("menuitem", { name: "Log out" }).click();
    }
    await expect(page).toHaveURL(/\/login/);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("kanera:session-cleanup"))).toBe("done");
    expect(await page.evaluate(async () => ({
      privateKeys: [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((key) =>
        /drafts|recent-boards|kanera.view|notes.selection|offline-identity/.test(key)),
      share: (await caches.keys()).includes("kanera-share-target-v1"),
      unrelated: localStorage.getItem("unrelated-app"),
      density: localStorage.getItem("kanera-density"),
    }))).toEqual({ privateKeys: [], share: false, unrelated: "preserved", density: "compact" });
    expect(await page.evaluate(() => new Promise<number>((resolve, reject) => {
      const request = indexedDB.open("kanera-offline");
      request.onerror = () => reject(request.error ?? new Error("Could not open offline database"));
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(Array.from(db.objectStoreNames));
        let count = 0;
        for (const name of Array.from(db.objectStoreNames)) {
          const rows = tx.objectStore(name).count();
          rows.onsuccess = () => { count += rows.result; };
        }
        tx.oncomplete = () => { db.close(); resolve(count); };
      };
    }))).toBe(0);
    await page.screenshot({ path: test.info().outputPath(`logout-${reason}-desktop.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: test.info().outputPath(`logout-${reason}-phone.png`) });
    if (reason === "explicit") {
      await page.locator("#email").fill(users.marcus.email);
      await page.locator("#password").fill(TEST_PASSWORD);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.locator("k-app-shell")).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem("kanera:session-cleanup"))).toBeNull();
      expect(await page.evaluate(() => localStorage.getItem("kanera:editor-drafts"))).toBeNull();
    }
  });
}

for (const failure of ["rejected", "blocked"] as const) {
test(`logout cleanup ${failure}: stays silent, allows sign-in and retries automatically`, async ({ page, signIn }) => {
  await signIn(page, "amelia");
  await expect(page.locator("k-app-shell")).toBeVisible();
  await page.evaluate(async (failure) => {
    const cache = await caches.open("kanera-share-target-v1");
    await cache.put("/share-target-payload/private", new Response("Private share"));
    Object.defineProperty(caches, "delete", { configurable: true, value: () => failure === "rejected"
      ? Promise.reject(new Error("Storage unavailable")) : new Promise(() => undefined) });
  }, failure);
  await page.getByRole("button", { name: users.amelia.name }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator("#email")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("silent-cleanup-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath("silent-cleanup-phone.png") });
  await page.locator("#email").fill(users.marcus.email);
  await page.locator("#password").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("k-app-shell")).toBeVisible();
  // The next account can work online while old browser storage remains quarantined.
  expect(await page.evaluate(() => localStorage.getItem("kanera:cleanup-pending"))).toBe("1");
  expect(await page.evaluate(() => localStorage.getItem("kanera:session-cleanup"))).toBeNull();
  await page.reload();
  await expect(page.locator("k-app-shell")).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("kanera:cleanup-pending"))).toBeNull();
  expect(await page.evaluate(() => caches.keys())).not.toContain("kanera-share-target-v1");
});

}

test("a new PWA share survives the login check when already signed out", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator("#email")).toBeVisible();
  await page.evaluate(async () => {
    const cache = await caches.open("kanera-share-target-v1");
    await cache.put("/share-target-payload/incoming", new Response("New incoming share"));
  });
  await page.reload();
  await expect(page.locator("#email")).toBeVisible();
  expect(await page.evaluate(async () => {
    const cache = await caches.open("kanera-share-target-v1");
    return (await cache.match("/share-target-payload/incoming"))?.text();
  })).toBe("New incoming share");
});


test("logout stays signed out after reload when server revocation was unavailable", async ({ page, signIn }) => {
  await signIn(page, "amelia");
  await expect(page.locator("k-app-shell")).toBeVisible();
  await page.route("**/api/auth/logout", (route) => route.abort());
  await page.getByRole("button", { name: users.amelia.name }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("kanera:session-cleanup"))).toBe("done");
  await page.unroute("**/api/auth/logout");
  await page.reload();
  await expect(page.locator("#email")).toBeVisible();
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator("k-app-shell")).toHaveCount(0);
});
