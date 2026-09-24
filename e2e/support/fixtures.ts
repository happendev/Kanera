import { test as base, expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { contextDefaults, SEED_PASSWORD, users, webOrigin, type SeedUser } from "./env";

type LoginResult = { status: string; accessToken?: string };

type Fixtures = {
  /** Signs `page`'s context in as a seeded user through the API and lands on the app shell. */
  signIn: (page: Page, user: SeedUser) => Promise<void>;
  /**
   * A signed-in page for another seeded user, in its own browser context (closed after the test).
   * `beforeSignIn` runs on the fresh context first, for routes that must exist before the app loads.
   */
  pageAs: (user: SeedUser, options?: { beforeSignIn?: (context: BrowserContext) => Promise<void> }) => Promise<Page>;
  /** An authenticated app-API client for setup that is not the subject of the test; paths start with `/api/`. */
  apiAs: (user: SeedUser) => Promise<APIRequestContext>;
  /** A name unique to this test and repeat, so `--repeat-each` and shared titles never collide. */
  uniqueName: (label: string) => string;
  runtimeGuard: RuntimeGuard;
};

// Browser-side failures that a user-flow assertion can miss: an uncaught exception or an API 5xx
// can leave the page looking right while the write was lost. Failed 4xx loads are deliberately not
// errors here: access-denial flows expect them, and the response listener already reports 5xx.
class RuntimeGuard {
  readonly problems: string[] = [];

  watchContext(context: BrowserContext, label: string) {
    for (const page of context.pages()) this.watchPage(page, label);
    context.on("page", (page) => this.watchPage(page, label));
  }

  private watchPage(page: Page, label: string) {
    page.on("pageerror", (error) => this.problems.push(`[${label}] uncaught page error: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() !== "error" || message.text().startsWith("Failed to load resource:")) return;
      // NG02955 is a dev-mode performance advisory (an unprioritised LCP image), not a runtime
      // failure; whether it fires depends on which card cover happens to be largest at load.
      if (message.text().startsWith("NG02955:")) return;
      this.problems.push(`[${label}] console.error: ${message.text()}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 500) this.problems.push(`[${label}] HTTP ${response.status()} ${response.request().method()} ${response.url()}`);
    });
  }
}

async function login(request: APIRequestContext, user: SeedUser): Promise<string> {
  const response = await request.post("/api/auth/login", { data: { email: users[user].email, password: SEED_PASSWORD } });
  expect(response.status(), `login as ${user}`).toBe(200);
  const body = (await response.json()) as LoginResult;
  expect(body.status, `login as ${user} should not need MFA`).toBe("authenticated");
  return body.accessToken!;
}

export const test = base.extend<Fixtures>({
  runtimeGuard: [
    async ({ context }, use, testInfo) => {
      const guard = new RuntimeGuard();
      guard.watchContext(context, "page");
      await use(guard);
      if (guard.problems.length > 0) {
        await testInfo.attach("runtime-problems.txt", { body: guard.problems.join("\n"), contentType: "text/plain" });
        throw new Error(`Browser runtime problems during the test:\n${guard.problems.join("\n")}`);
      }
    },
    { auto: true },
  ],

  signIn: async ({}, use) => {
    await use(async (page, user) => {
      // Password login through the form is covered once in auth.spec.ts. Everything else signs in
      // through the API: /auth/login is rate limited per IP, and a UI login per user per test made
      // the suite's headroom depend on how fast the machine ran it.
      await login(page.request, user);
      await page.goto("/");
      await expect(page.locator("k-app-shell")).toBeVisible();
    });
  },

  pageAs: async ({ browser, runtimeGuard, signIn }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (user, options) => {
      const context = await browser.newContext(contextDefaults);
      contexts.push(context);
      runtimeGuard.watchContext(context, user);
      await options?.beforeSignIn?.(context);
      const page = await context.newPage();
      await signIn(page, user);
      return page;
    });
    for (const context of contexts) await context.close();
  },

  apiAs: async ({ playwright }, use) => {
    const clients: APIRequestContext[] = [];
    await use(async (user) => {
      const anonymous = await playwright.request.newContext({ baseURL: webOrigin });
      clients.push(anonymous);
      const accessToken = await login(anonymous, user);
      const client = await playwright.request.newContext({
        baseURL: webOrigin,
        extraHTTPHeaders: { authorization: `Bearer ${accessToken}` },
      });
      clients.push(client);
      return client;
    });
    for (const client of clients) await client.dispose();
  },

  uniqueName: async ({}, use, testInfo) => {
    let counter = 0;
    const suffix = `${testInfo.testId.slice(0, 6)}${testInfo.repeatEachIndex ? `r${testInfo.repeatEachIndex}` : ""}`;
    await use((label) => `${label} ${suffix}${counter++ === 0 ? "" : `-${counter}`}`);
  },
});

export { expect };
