import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test as base, expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { contextDefaults, TEST_PASSWORD, users, webOrigin, type TestUser } from "./env";

type LoginResult = { status: string; accessToken?: string };

type Fixtures = {
  accounts: void;
  workspaceOptions: { boardName?: string; lists?: { name: string; inProgress?: boolean }[] };
  /** An empty workspace owned by this test, removed even when an assertion fails. */
  testWorkspace: {
    id: string; name: string; boardId: string; boardName: string;
    lists: Map<string, string>;
    addBoard: (name: string) => Promise<string>;
  };
  /** Signs in through the API and opens the destination directly, avoiding an unused Home boot. */
  signIn: (page: Page, user: TestUser, destination?: string) => Promise<void>;
  /**
   * A signed-in page for another test user, in its own browser context (closed after the test).
   * `beforeSignIn` runs on the fresh context first, for routes that must exist before the app loads.
   */
  pageAs: (user: TestUser, options?: { beforeSignIn?: (context: BrowserContext) => Promise<void> }) => Promise<Page>;
  /** An authenticated app-API client for setup that is not the subject of the test; paths start with `/api/`. */
  apiAs: (user: TestUser) => Promise<APIRequestContext>;
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
    page.on("pageerror", (error) => this.problems.push(`[${label}] uncaught page error: ${error.stack ?? error.message}`));
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

async function login(request: APIRequestContext, user: TestUser): Promise<string> {
  const response = await request.post("/api/auth/login", { data: { email: users[user].email, password: TEST_PASSWORD } });
  expect(response.status(), `login as ${user}`).toBe(200);
  const body = (await response.json()) as LoginResult;
  expect(body.status, `login as ${user} should not need MFA`).toBe("authenticated");
  return body.accessToken!;
}

export const test = base.extend<Fixtures>({
  accounts: [async ({}, use, testInfo) => {
    const manifestPath = testInfo.outputPath("accounts.json");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify({
      clientIds: [randomUUID(), randomUUID()], password: TEST_PASSWORD,
      users: Object.entries(users).map(([key, person]) => ({
        ...person, external: key === "maya", role: key === "amelia" || key === "maya" ? "owner" : key === "marcus" ? "admin" : "member",
      })),
    }));
    const run = (action: string) => promisify(execFile)("pnpm", ["--filter", "@kanera/api", "exec", "tsx", "src/scripts/e2e-accounts.ts", action, manifestPath], {
      cwd: path.resolve(__dirname, "../.."), timeout: 30_000,
    });
    try {
      await run("create");
      await use();
    } finally {
      await run("delete");
    }
  }, { auto: true }],
  workspaceOptions: [{}, { option: true }],
  testWorkspace: async ({ apiAs, workspaceOptions }, use, testInfo) => {
    const api = await apiAs("amelia");
    // Keep fixture names independent of the test's naming counter and short credential labels.
    const suffix = `${testInfo.testId.slice(0, 6)}-${testInfo.repeatEachIndex}`;
    const name = `E2E owned workspace ${suffix}`;
    const boardName = workspaceOptions.boardName ?? `E2E owned board ${suffix}`;
    const created = await api.post("/api/workspaces", { data: {
      name, initialBoard: { name: boardName, iconColor: "blue" },
      lists: workspaceOptions.lists ?? [{ name: "Backlog" }, { name: "Wishlist" }, { name: "In Progress", inProgress: true }, { name: "Done" }],
      customFields: [], labels: [], timeZone: "UTC",
    } });
    expect(created.ok(), await created.text()).toBe(true);
    const workspace = await created.json() as { id: string; initialBoard: { id: string } };
    try {
      // Workspace membership alone does not grant board access. Admin roles materialize pinned
      // board memberships; explicit memberships also make Marcus assignable, unlike an access override.
      const members = await Promise.all((["marcus", "priya"] as const).map(async (person) => {
        const profile = await (await apiAs(person)).get("/api/me");
        expect(profile.ok(), await profile.text()).toBe(true);
        return await profile.json() as { id: string };
      }));
      for (const user of members) {
        const member = await api.post(`/api/workspaces/${workspace.id}/members`, { data: { userId: user.id, role: "admin" } });
        expect(member.ok(), await member.text()).toBe(true);
      }
      const opened = await api.get(`/api/boards/${workspace.initialBoard.id}?includeCards=false`);
      expect(opened.ok(), await opened.text()).toBe(true);
      const board = await opened.json() as { lists: { id: string; name: string }[] };
      await use({
        id: workspace.id, name, boardId: workspace.initialBoard.id, boardName,
        lists: new Map(board.lists.map((list) => [list.name, list.id])),
        addBoard: async (name) => {
          const response = await api.post(`/api/workspaces/${workspace.id}/boards`, { data: { name } });
          expect(response.ok(), await response.text()).toBe(true);
          return (await response.json() as { id: string }).id;
        },
      });
    } finally {
      const removed = await api.delete(`/api/workspaces/${workspace.id}`, { data: { confirmationName: name } });
      expect(removed.ok(), await removed.text()).toBe(true);
    }
  },
  runtimeGuard: [
    async ({ context, accounts: _accounts }, use, testInfo) => {
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

  signIn: async ({ accounts: _accounts }, use) => {
    await use(async (page, user, destination = "/") => {
      // Password login through the form is covered once in auth.spec.ts. Everything else signs in
      // through the API: /auth/login is rate limited per IP, and a UI login per user per test made
      // the suite's headroom depend on how fast the machine ran it.
      await login(page.request, user);
      await page.goto(destination);
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

  apiAs: async ({ playwright, accounts: _accounts }, use) => {
    const clients: APIRequestContext[] = [];
    // Setup calls for one user in one test share a session. Never share across tests or with
    // browser contexts: fresh-device, refresh-cookie and logout behavior still need real logins.
    const sessions = new Map<TestUser, Promise<APIRequestContext>>();
    const createClient = async (user: TestUser) => {
      const anonymous = await playwright.request.newContext({ baseURL: webOrigin });
      clients.push(anonymous);
      const accessToken = await login(anonymous, user);
      const client = await playwright.request.newContext({
        baseURL: webOrigin,
        extraHTTPHeaders: { authorization: `Bearer ${accessToken}` },
      });
      clients.push(client);
      return client;
    };
    await use((user) => {
      let session = sessions.get(user);
      if (!session) {
        session = createClient(user);
        sessions.set(user, session);
      }
      return session;
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
