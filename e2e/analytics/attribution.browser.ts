import { expect, test } from "@playwright/test";

const projectKey = "phc_AnalyticsRegressionTest12345";
const initialIdentity = "consented-marketing-visitor";

for (const consented of [true, false]) {
  test(`signup preserves first-touch identity and submits attribution only with consent (${consented})`, async ({ page, context }, testInfo) => {
    const stamp = new Date().toISOString();
    const cookies = {
      kanera_cookie_consent: JSON.stringify({ version: 1, necessary: true, analytics: consented, marketing: false, updatedAt: stamp }),
      [`ph_${projectKey}_posthog`]: JSON.stringify({ distinct_id: initialIdentity, $device_id: initialIdentity, $user_state: "anonymous" }),
      kanera_analytics_source: "youtube",
      kanera_analytics_medium: "video",
      kanera_analytics_campaign: "launch",
      kanera_analytics_content: "intro-a",
      kanera_analytics_landing_page: "/pricing",
      kanera_analytics_captured_at: stamp,
      kanera_analytics_gclid: "private-click-id",
    };
    await context.addCookies(Object.entries(cookies).map(([name, value]) => ({ name, value: encodeURIComponent(value), domain: ".kanera.test", path: "/" })));
    let signup: Record<string, unknown> | undefined;
    const analyticsRequests: string[] = [];
    // Explicitly block all external traffic; the SDK's host is fake and every backend is mocked.
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "analytics.example.test") {
        analyticsRequests.push(url.pathname);
        return route.fulfill({ json: {} });
      }
      if (url.hostname !== "board.kanera.test") return route.abort();
      if (url.pathname === "/api/auth/config") return route.fulfill({ json: {
        deploymentMode: "hosted", kaneraEnvironment: "production", emailVerificationEnabled: false,
        signupsEnabled: true, turnstileSiteKey: null,
        analytics: { enabled: true, provider: "posthog", projectKey, apiHost: "https://analytics.example.test" },
      } });
      if (url.pathname === "/api/auth/signup") {
        signup = route.request().postDataJSON() as Record<string, unknown>;
        return route.fulfill({ status: 400, json: { message: "Captured by local test" } });
      }
      if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 401, json: {} });
      return route.continue();
    });
    await page.goto("/signup?utm_source=later&utm_campaign=wrong");
    await expect(page.getByLabel("Your name", { exact: true })).toBeVisible();
    if (consented) {
      await expect.poll(() => page.evaluate((key) => {
        const raw = localStorage.getItem(`ph_${key}_posthog`);
        return raw ? (JSON.parse(raw) as { distinct_id: string }).distinct_id : null;
      }, projectKey)).toBe(initialIdentity);
    }
    await page.getByLabel("Your name", { exact: true }).fill("Test Owner");
    await page.getByLabel("Email", { exact: true }).fill("analytics@example.test");
    await page.getByLabel("Password", { exact: true }).fill("Abc12345");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect.poll(() => signup).toBeDefined();
    if (consented) expect(signup?.analyticsAttribution).toMatchObject({
      source: "youtube", medium: "video", campaign: "launch", content: "intro-a",
      landing_page: "/pricing", gclid: "private-click-id", captured_at: stamp, consented_at: stamp, consent_version: 1,
    });
    else {
      expect(signup).not.toHaveProperty("analyticsAttribution");
      expect(analyticsRequests).toEqual([]);
    }
    await page.screenshot({ path: testInfo.outputPath("signup-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("signup-mobile.png") });
  });
}

for (const marketing of [true, false]) {
  test(`a completed signup embeds the marketing site's conversion page only with the advertising choice on (${marketing})`, async ({ page, context }) => {
    const consent = JSON.stringify({ version: 1, necessary: true, analytics: false, marketing, updatedAt: new Date().toISOString() });
    await context.addCookies([{ name: "kanera_cookie_consent", value: encodeURIComponent(consent), domain: ".kanera.test", path: "/" }]);
    const conversionFrames: string[] = [];
    const scriptHosts = new Set<string>();
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().resourceType() === "script") scriptHosts.add(url.hostname);
      if (url.hostname === "www.kanera.app" && url.pathname === "/conversion/signup") {
        conversionFrames.push(route.request().frame().parentFrame() ? "framed" : "top");
        return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Kanera</title>" });
      }
      if (url.hostname !== "board.kanera.test") return route.abort();
      if (url.pathname === "/api/auth/config") return route.fulfill({ json: {
        deploymentMode: "hosted", kaneraEnvironment: "production", emailVerificationEnabled: false,
        signupsEnabled: true, turnstileSiteKey: null,
        analytics: { enabled: true, provider: "posthog", projectKey, apiHost: "https://analytics.example.test" },
      } });
      // The account is created but its organisation still requires MFA: the shortest real success path.
      if (url.pathname === "/api/auth/signup") return route.fulfill({ json: { status: "mfa_enrollment_required", challengeToken: "local-test" } });
      if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 401, json: {} });
      return route.continue();
    });
    await page.goto("/signup");
    await page.getByLabel("Your name", { exact: true }).fill("Test Owner");
    await page.getByLabel("Email", { exact: true }).fill("conversion@example.test");
    await page.getByLabel("Password", { exact: true }).fill("Abc12345");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForURL(/\/login/);
    if (marketing) await expect.poll(() => conversionFrames).toEqual(["framed"]);
    else expect(conversionFrames).toEqual([]);
    // Google's tag belongs to the marketing site; no third-party script may run in the app itself.
    expect([...scriptHosts]).toEqual(["board.kanera.test"]);
  });
}
