import { createHmac } from "node:crypto";
import { expect, test } from "./support/fixtures";

// Mirrors lifecycleUnsubscribeToken in apps/api/src/lib/lifecycle-emails.ts. The emails that carry
// this link are only sent by the hosted lifecycle sweep, which the self-hosted E2E stack never runs,
// so the spec signs the same token the email would contain. scripts/test-e2e.sh exports JWT_SECRET to
// both the API and this runner.
function unsubscribeToken(userId: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET must be exported by scripts/test-e2e.sh");
  const signature = createHmac("sha256", secret).update(`kanera:lifecycle-unsubscribe:v1:${userId}`).digest("base64url");
  return `${userId}.${signature}`;
}

type Settings = { lifecycleEmail: boolean; emailEnabled: boolean };

test("the email unsubscribe link and one-click header opt out only on purpose, signed out, and reject forged links", async ({ page, apiAs, request }) => {
  const api = await apiAs("priya");
  const me = await (await api.get("/api/me")).json() as { id?: string; user?: { id: string } };
  const userId = me.user?.id ?? me.id!;
  const settings = async () => (await (await api.get("/api/notifications/settings")).json()) as Settings;

  try {
    expect((await settings()).lifecycleEmail).toBe(true);

    // A forged link (another signature) is rejected and changes nothing.
    await page.goto(`/email/unsubscribe?token=${encodeURIComponent(`${userId}.forged-signature`)}`);
    await page.getByRole("button", { name: "Unsubscribe" }).click();
    await expect(page.getByText("This unsubscribe link is invalid.")).toBeVisible();
    expect((await settings()).lifecycleEmail).toBe(true);

    // The real link works without a session. Opening it must not unsubscribe by itself: inbox link
    // scanners prefetch URLs, so only the explicit click may change the preference.
    await page.goto(`/email/unsubscribe?token=${encodeURIComponent(unsubscribeToken(userId))}`);
    await expect(page.getByRole("button", { name: "Unsubscribe" })).toBeVisible();
    expect((await settings()).lifecycleEmail).toBe(true);

    await page.getByRole("button", { name: "Unsubscribe" }).click();
    await expect(page.getByText("You're unsubscribed from onboarding and account tips.")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("unsubscribed.png") });

    const after = await settings();
    expect(after.lifecycleEmail).toBe(false);
    // Card notification email is a separate preference and must stay on.
    expect(after.emailEnabled).toBe(true);

    // The List-Unsubscribe header's one-click target, through the same /api proxy path production
    // uses. Mail providers POST this form body from their servers, with no session or page.
    await api.patch("/api/notifications/settings", { data: { lifecycleEmail: true } });
    const oneClick = await request.post(`/api/email/unsubscribe/one-click?token=${encodeURIComponent(unsubscribeToken(userId))}`, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      data: "List-Unsubscribe=One-Click",
    });
    expect(oneClick.status()).toBe(200);
    expect((await settings()).lifecycleEmail).toBe(false);
  } finally {
    await api.patch("/api/notifications/settings", { data: { lifecycleEmail: true } });
  }
});

test("the onboarding-tips toggle is hidden on self-hosted deployments, which never send them", async ({ page, signIn }) => {
  await signIn(page, "amelia");
  await page.goto("/settings/notifications");
  await expect(page.getByText("Allow email notifications")).toBeVisible();
  await expect(page.getByText("Send me onboarding and account tips")).toHaveCount(0);
});
