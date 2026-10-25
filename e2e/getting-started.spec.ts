import { SEED_PASSWORD } from "./support/env";
import { expect, test } from "./support/fixtures";
import { cardTile, createCard, expectBoardLoaded, signUp } from "./support/ui";

// A fresh account per run: closing the checklist is permanent for the account, so a seeded user
// would only ever show it once per database.
test("the getting started checklist guides step by step, ticks itself off, hides to the account menu and can be removed", async ({ page, uniqueName }, testInfo) => {
  const boardName = uniqueName("E2E Checklist board");
  const email = await signUp(page, uniqueName("E2E checklist signup"));
  await page.locator(".ob-kind-option").filter({ hasText: "Create a board" }).click();
  await page.getByPlaceholder("e.g. Product launch").fill(boardName);
  await page.locator(".ob-footer").getByRole("button", { name: "Create board" }).click();
  await expectBoardLoaded(page, boardName);

  await page.goto("/");
  const card = page.locator("k-getting-started .getting-started");
  const step = (title: string) => card.locator(".gs-step").filter({ has: page.locator(".gs-label", { hasText: title }) });
  await expect(card.getByRole("heading", { name: "Getting started" })).toBeVisible();
  // Template starter cards do not count as the user's first card: nothing is done yet.
  await expect(card.locator(".gs-step.is-done")).toHaveCount(0);
  // The guide opens the first step, with the way to do it.
  await expect(step("Create your first card")).toHaveClass(/is-open/);
  await card.screenshot({ path: testInfo.outputPath("getting-started.png") });

  // A basics step done on the board itself ticks when the user comes back home, and the guide
  // moves on to the next step.
  // The open step's button sits in the spotlight on a wide card and under its row on a narrow one;
  // only the visible one has a role, so look it up on the card.
  await card.getByRole("link", { name: "Open a board" }).click();
  await expectBoardLoaded(page, boardName);
  const firstCard = uniqueName("E2E first card");
  await createCard(page, firstCard);
  // Quick edit leaves no row behind, so the web stamps it when the panel opens from a right-click.
  await cardTile(page, firstCard).click({ button: "right" });
  await page.locator("k-card-actions-menu").getByRole("button", { name: /Quick edit/ }).click();
  await expect(page.locator("k-card-quick-edit")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto("/");
  await expect(step("Create your first card")).toHaveClass(/is-done/);
  await expect(step("Quick edit a card")).toHaveClass(/is-done/);
  await expect(step("Assign a card")).toHaveClass(/is-open/);

  // The palette step ticks while home is still on screen: the overlay that stamps it lives in the
  // shell, and the tick must not wait for a reload.
  await step("Try the command palette").getByRole("button", { name: "Try the command palette" }).click();
  await card.getByRole("button", { name: "Try it" }).click();
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(step("Try the command palette")).toHaveClass(/is-done/);
  await expect(card.locator(".gs-count")).toHaveText(/^3\//);

  // A step done somewhere else (the API here, as another tab or the CLI would) ticks when the user
  // comes back to the tab, with nothing marked by hand.
  const login = await page.request.post("/api/auth/login", { data: { email, password: SEED_PASSWORD } });
  expect(login.status()).toBe(200);
  const { accessToken } = (await login.json()) as { accessToken: string };
  const invite = await page.request.post("/api/clients/me/invites", {
    headers: { authorization: `Bearer ${accessToken}` },
    data: { orgRole: "member", workspaces: [] },
  });
  expect(invite.status(), await invite.text()).toBe(201);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(step("Invite your team")).toHaveClass(/is-done/);
  await expect(card.locator(".gs-count")).toHaveText(/^4\//);

  // A standalone-only organisation has no workspace settings to send people to, so its board step
  // opens the same dialog as the sidebar.
  await step("Create a second board").getByRole("button", { name: "Create a second board" }).click();
  await card.getByRole("button", { name: "New board" }).click();
  await expect(page.getByRole("dialog", { name: "Create standalone board" })).toBeVisible();
  await page.keyboard.press("Escape");

  // The account menu carries the checklist's progress while it has steps left, on home or not.
  const accountMenu = page.locator(".user-trigger");
  const ring = page.getByRole("menuitem", { name: /^Getting started, 4 of \d+ steps done/ });
  await accountMenu.click();
  await expect(ring).toBeVisible();
  await page.keyboard.press("Escape");

  // With steps left, closing on home hides the checklist; the menu still has it.
  await card.getByRole("button", { name: "Hide getting started" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByText("Getting started is in your account menu whenever you want it.")).toBeVisible();
  // Stored on the account, so it is still hidden, and still in the menu, after a reload elsewhere.
  await page.goto("/my-cards");
  await accountMenu.click();
  await expect(ring).toBeVisible();
  await page.locator(".user-popover").screenshot({ path: testInfo.outputPath("account-menu.png") });

  // The ring puts it back on home and goes there.
  await ring.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(step("Assign a card")).toHaveClass(/is-open/);

  // The × in the menu removes it for good: neither home nor the menu shows it again.
  await card.getByRole("button", { name: "Hide getting started" }).click();
  await accountMenu.click();
  await page.getByRole("menuitem", { name: "Remove getting started" }).click();
  await page.reload();
  await expect(page.locator(".focus-grid")).toBeVisible();
  await expect(page.locator("k-getting-started .getting-started")).toHaveCount(0);
  await accountMenu.click();
  await expect(page.getByRole("menuitem", { name: "Profile settings" })).toBeVisible();
  await expect(ring).toHaveCount(0);
});
