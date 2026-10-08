import type { BrowserContext, Page } from "@playwright/test";
import { contextDefaults, SEED_PASSWORD } from "./support/env";
import { expect, test } from "./support/fixtures";
import { totpCode } from "./support/totp";
import { expectBoardLoaded } from "./support/ui";

// An organisation that requires two-factor authentication must not hand a session to an account
// that joins it through an invitation while that account has no enabled factor. Password login
// already withholds the session; this spec covers the two invitation entry points (a brand-new
// account signing up through the invite and an existing account accepting it), each of which used
// to issue a full session, letting the member open and edit boards until a later refresh refused.
//
// Everything runs in organisations created inside the test: enabling the policy on a seeded
// organisation would break every other spec's API sign-in.

function emailFor(name: string) {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@kanera.test`;
}

async function signUpOwner(page: Page, name: string) {
  await page.goto("/signup");
  await page.locator("#cname").fill(name);
  await page.locator("#dn").fill(name);
  await page.locator("#email").fill(emailFor(name));
  await page.locator("#password").fill(SEED_PASSWORD);
  await page.locator("#confirm-password").fill(SEED_PASSWORD);
  await page.locator("form").getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/onboarding/);
}

async function createStandaloneBoard(page: Page, boardName: string): Promise<string> {
  await page.locator(".ob-kind-option").filter({ hasText: "Create a board" }).click();
  await page.getByPlaceholder("e.g. Product launch").fill(boardName);
  await page.locator(".ob-footer").getByRole("button", { name: "Create board" }).click();
  await expect(page).toHaveURL(/\/b\/[^/]+$/);
  await expectBoardLoaded(page, boardName);
  return new URL(page.url()).pathname.split("/").pop()!;
}

// The policy and the invite are set up through the API as the owner, who signed in before the policy
// existed; the owner's own enrollment is covered by the API login tests and is not the subject here.
async function requireMfaAndInvite(page: Page, ownerEmail: string): Promise<string> {
  const login = await page.request.post("/api/auth/login", { data: { email: ownerEmail, password: SEED_PASSWORD } });
  expect(login.status()).toBe(200);
  const { accessToken } = (await login.json()) as { accessToken: string };
  const headers = { authorization: `Bearer ${accessToken}` };
  const policy = await page.request.patch("/api/clients/me", { headers, data: { requireMfa: true } });
  expect(policy.status(), await policy.text()).toBe(200);
  const invite = await page.request.post("/api/clients/me/invites", { headers, data: { orgRole: "admin", workspaces: [] } });
  expect(invite.status(), await invite.text()).toBe(201);
  return ((await invite.json()) as { token: string }).token;
}

async function expectEnrollmentRequired(page: Page) {
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText("Two-factor authentication is required by your organisation")).toBeVisible();
  await expect(page.getByRole("img", { name: "Authenticator setup QR code" })).toBeVisible();
  await expect(page.locator("k-app-shell")).toHaveCount(0);
}

// Reads the secret the page shows, answers with a real TOTP and acknowledges the recovery codes, which
// is the only point at which the organisation's session is issued.
async function completeEnrollment(page: Page) {
  const secret = (await page.locator(".auth-card code").innerText()).trim();
  await page.locator("#mfa-code").fill(totpCode(secret));
  await page.getByRole("button", { name: "Enable and continue" }).click();
  await expect(page.locator(".auth-card pre")).toBeVisible();
  await page.getByRole("button", { name: "I saved these codes" }).click();
  await expect(page.locator("k-app-shell")).toBeVisible();
}

test("joining an organisation that requires MFA through an invite withholds the session until enrollment, for new and existing accounts", async ({ page, browser, runtimeGuard, uniqueName }, testInfo) => {
  const ownerName = uniqueName("E2E MFA owner");
  const boardName = uniqueName("E2E MFA board");
  await signUpOwner(page, ownerName);
  const boardId = await createStandaloneBoard(page, boardName);
  const inviteToken = await requireMfaAndInvite(page, emailFor(ownerName));

  const contexts: BrowserContext[] = [];
  try {
    // 1. A brand-new account created through the invite link.
    const newcomerContext = await browser.newContext(contextDefaults);
    contexts.push(newcomerContext);
    runtimeGuard.watchContext(newcomerContext, "newcomer");
    const newcomer = await newcomerContext.newPage();
    const newcomerName = uniqueName("E2E MFA newcomer");
    await newcomer.goto(`/signup?invite=${encodeURIComponent(inviteToken)}`);
    await expect(newcomer.locator(".invite-banner")).toContainText("You've been invited to join");
    await newcomer.locator("#dn").fill(newcomerName);
    await newcomer.locator("#email").fill(emailFor(newcomerName));
    await newcomer.locator("#password").fill(SEED_PASSWORD);
    await newcomer.locator("#confirm-password").fill(SEED_PASSWORD);
    await newcomer.locator("form").getByRole("button", { name: "Continue" }).click();

    await expectEnrollmentRequired(newcomer);
    await newcomer.screenshot({ path: testInfo.outputPath("newcomer-enrollment-required.png") });
    // Signup set no refresh cookie, so the browser holds nothing that could become a session.
    const newcomerRefresh = await newcomer.request.post("/api/auth/refresh", { data: {} });
    expect(newcomerRefresh.status(), "no refresh cookie was issued to the unenrolled newcomer").toBe(401);

    await completeEnrollment(newcomer);
    await newcomer.goto(`/b/${boardId}`);
    await expectBoardLoaded(newcomer, boardName);
    await newcomer.screenshot({ path: testInfo.outputPath("newcomer-board-after-enrollment.png") });

    // 2. An existing account (its own organisation, no factor) accepting the same invite link.
    const existingContext = await browser.newContext(contextDefaults);
    contexts.push(existingContext);
    runtimeGuard.watchContext(existingContext, "existing");
    const existing = await existingContext.newPage();
    const existingName = uniqueName("E2E MFA existing");
    await signUpOwner(existing, existingName);
    // A cold load of the invite link must hydrate the session from the refresh cookie and offer
    // Join directly, not the signed-out "Create account / Sign in" actions.
    await existing.goto(`/invite?token=${encodeURIComponent(inviteToken)}`);
    await existing.getByRole("button", { name: /Join / }).click();

    await expectEnrollmentRequired(existing);
    await existing.screenshot({ path: testInfo.outputPath("existing-enrollment-required.png") });
    // The pre-acceptance refresh cookie now points at the MFA organisation and is refused outright.
    const existingRefresh = await existing.request.post("/api/auth/refresh", { data: {} });
    expect(existingRefresh.status(), "the old refresh cookie cannot mint a session for the MFA organisation").toBe(403);

    await completeEnrollment(existing);
    await existing.goto(`/b/${boardId}`);
    await expectBoardLoaded(existing, boardName);
    await existing.screenshot({ path: testInfo.outputPath("existing-board-after-enrollment.png") });
  } finally {
    for (const context of contexts) await context.close();
  }
});
