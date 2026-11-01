const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../../apps/web/dist/web");
const stats = JSON.parse(fs.readFileSync(path.join(root, "stats.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "browser/ngsw.json"), "utf8"));
const outputFor = (suffix) => Object.keys(stats.outputs).find((file) => Object.keys(stats.outputs[file].inputs).some((input) => input.endsWith(suffix)));

// Production-only checks complement the isolated E2E suite, whose development server does not
// exercise Nginx headers, font subsets, tree splitting or actual service-worker installation.
test("every hashed bundle is immutable; control files and missing bundles revalidate", async ({ request }) => {
  for (const file of Object.keys(stats.outputs).filter((file) => /\.(?:js|css)$/.test(file) && fs.existsSync(path.join(root, "browser", file)))) {
    const response = await request.head(`/${file}`);
    expect(response.status(), file).toBe(200);
    expect(response.headers()["cache-control"], file).toBe("public, max-age=31536000, immutable");
  }
  for (const file of ["index.html", "ngsw.json", "push-worker.js"]) {
    expect((await request.head(`/${file}`)).headers()["cache-control"], file).toBe("no-cache");
  }
  const missing = await request.get("/board.page-missing123.js");
  expect(missing.status()).toBe(404);
  expect(missing.headers()["cache-control"]).toBe("no-cache");
  const main = Object.keys(stats.outputs).find((file) => file.startsWith("main-"));
  expect((await request.get(`/${main}`, { headers: { "Accept-Encoding": "gzip" } })).headers()["content-encoding"]).toBe("gzip");
});

test.describe("first-use features", () => {
  test.use({ serviceWorkers: "block" });
  test("board views and composer load on first use; arbitrary custom icons still render", async ({ page }, testInfo) => {
    const login = await page.context().request.post("/api/auth/login", {
      data: { email: process.env.BUNDLE_EMAIL ?? "priya@kanera.test", password: process.env.BUNDLE_PASSWORD ?? "Abc12345" },
    });
    expect(login.ok()).toBe(true);
    const { accessToken } = await login.json();
    try {
      const response = await page.context().request.get("/api/home/boards", { headers: { Authorization: `Bearer ${accessToken}` } });
      expect(response.ok()).toBe(true);
      const home = await response.json();
      const boardId = process.env.BUNDLE_BOARD_ID ?? home.groups.flatMap((group) => group.boards)[0]?.id;
      expect(boardId).toBeTruthy();
      const requests = new Set();
      page.on("request", (request) => requests.add(new URL(request.url()).pathname.slice(1)));
      await page.goto(`/b/${boardId}?view=board`);
      await expect(page.getByRole("button", { name: "New card", exact: true })).toBeEnabled();
      await page.evaluate(() => document.fonts.ready.then(() => true));
      const features = [
        ["Table view", "k-board-table-view", "board-table-view.component.ts"],
        ["Calendar view", "k-board-calendar-view", "board-calendar-view.component.ts"],
        ["Timeline view", "k-board-timeline-view", "board-timeline-view.component.ts"],
        ["Dependencies view", "k-dependency-map", "dependency-map.component.ts"],
      ];
      for (const suffix of ["description-editor.component.ts", ...features.map((feature) => feature[2])]) {
        expect(requests.has(outputFor(suffix)), `${suffix} must remain deferred`).toBe(false);
      }
      // Saved board/list icons may legitimately request a small catalogue subset.
      for (const file of [...requests].filter((file) => file.includes("tabler-icons-extra-"))) {
        expect(fs.statSync(path.join(root, "browser", file)).size).toBeLessThan(64 * 1024);
      }
      await page.screenshot({ animations: "disabled", path: testInfo.outputPath("board-desktop.png") });
      await page.getByRole("button", { name: "New card", exact: true }).click();
      const composer = page.getByRole("dialog", { name: "New card", exact: true });
      await expect(composer.locator(".tiptap")).toBeVisible();
      expect(requests.has(outputFor("description-editor.component.ts"))).toBe(true);
      await composer.getByRole("button", { name: "Close", exact: true }).click();
      await expect(composer).toBeHidden();
      for (const [label, selector, suffix] of features) {
        await page.getByRole("button", { name: label, exact: true }).click();
        await expect(page.locator(selector)).toBeVisible();
        expect(requests.has(outputFor(suffix))).toBe(true);
      }
      await page.getByRole("button", { name: "Board view", exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ animations: "disabled", path: testInfo.outputPath("board-phone.png") });
      // An uncommon catalogue choice must work without widening the initial font or restricting
      // saved custom icons. Render it through the same CSS classes as board/list/icon pickers.
      await page.evaluate(() => {
        const icon = document.createElement("i");
        icon.className = "ti ti-a-b-2";
        icon.id = "bundle-custom-icon";
        icon.style.cssText = "position:fixed;top:10px;right:10px;z-index:99999;font-size:32px";
        document.body.append(icon);
      });
      const custom = page.locator("#bundle-custom-icon");
      await expect(custom).toBeVisible();
      const content = await custom.evaluate((element) => getComputedStyle(element, "::before").content.replaceAll('"', ""));
      expect(content.length).toBeGreaterThan(0);
      await page.evaluate((glyph) => document.fonts.load('32px "tabler-icons"', glyph).then(() => true), content);
      expect([...requests].some((file) => file.includes("tabler-icons-extra-"))).toBe(true);
      await page.screenshot({ animations: "disabled", path: testInfo.outputPath("custom-icon.png") });
    } finally {
      await page.context().request.post("/api/auth/logout");
    }
  });
});

test("offline installation waits for the first screen and fonts, then supports a cold offline reload", async ({ page }) => {
  await page.addInitScript(() => {
    const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = (...args) => {
      window.__offlineInstall = { time: performance.now(), fontStatus: document.fonts.status, screenVisible: !!document.querySelector("#email") };
      return register(...args);
    };
  });
  await page.goto("/login");
  await expect(page.locator("#email")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__offlineInstall), { timeout: 20_000 }).toMatchObject({ fontStatus: "loaded", screenVisible: true });
  const fonts = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name));
  expect(fonts.some((name) => name.includes("tabler-icons-core-"))).toBe(true);
  expect(fonts.some((name) => name.includes("tabler-icons-extra-"))).toBe(false);
  const shell = manifest.assetGroups.find((group) => group.name === "app-shell");
  await expect.poll(async () => page.evaluate(async () => {
    const key = (await caches.keys()).find((name) => name.endsWith("app-shell:cache"));
    return key ? (await (await caches.open(key)).keys()).length : 0;
  }), { timeout: 30_000 }).toBe(shell.urls.length);
  // A controlled load caches the fonts actually used; the full feature graph is already installed.
  await page.reload();
  await expect(page.locator("#email")).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.locator("#email")).toBeVisible();
  await expect(page.locator("#password")).toBeVisible();
});
