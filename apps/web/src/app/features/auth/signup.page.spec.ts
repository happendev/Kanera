import { provideZonelessChangeDetection } from "@angular/core";
import type { ComponentFixture } from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import { ActivatedRoute, Router } from "@angular/router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../../core/auth/auth.service";
import { ThemeService } from "../../core/theme/theme.service";
import { SignupPage } from "./signup.page";

describe("SignupPage", () => {
  let fixture: ComponentFixture<SignupPage>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let setSession: ReturnType<typeof vi.fn>;
  let navigateByUrl: ReturnType<typeof vi.fn>;
  let emailVerificationEnabled: boolean;
  let turnstileSiteKey: string | null;
  let signupsEnabled: boolean;
  let kaneraEnvironment: "development" | "test" | "staging" | "production";
  let deploymentMode: "self_hosted" | "hosted";
  let inviteToken: string | null;
  let boardInviteToken: string | null;
  let boardLookupStatus: number | null;
  let accountExists: boolean;
  let boardInviteRedirect: string | null;

  const authResponse = {
    accessToken: "access-token",
    user: {
      id: "user-1",
      clientId: "client-1",
      email: "owner@example.com",
      displayName: "Owner",
      avatarUrl: null,
      orgName: "Acme",
      logoUrl: null,
      deploymentMode: "self_hosted",
      kaneraEnvironment: "development",
      hasWorkspace: false,
      isClientAdmin: true,
      role: "owner",
      timezone: "UTC",
      storageUsage: {
        usedBytes: 0,
        quotaBytes: null,
        remainingBytes: null,
        limited: false,
        maxFileBytes: 104_857_600,
      },
    },
  };

  beforeEach(async () => {
    emailVerificationEnabled = false;
    turnstileSiteKey = null;
    signupsEnabled = true;
    kaneraEnvironment = "production";
    deploymentMode = "hosted";
    inviteToken = null;
    boardInviteToken = null;
    boardLookupStatus = null;
    accountExists = false;
    boardInviteRedirect = null;
    setSession = vi.fn();
    navigateByUrl = vi.fn();
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlFromRequest(input);
      if (url.endsWith("/auth/config")) {
        return response({ emailVerificationEnabled, signupsEnabled, turnstileSiteKey, kaneraEnvironment, deploymentMode });
      }
      if (url.includes("/invites/lookup")) {
        return response({ orgName: "Invite Org", orgRole: "member", workspaces: [] });
      }
      if (url.includes("/board-invitations/lookup")) {
        if (boardLookupStatus !== null) return response({}, false, boardLookupStatus);
        return response({
          id: "board-invite-1",
          email: "owner@example.com",
          boardId: "board-1",
          boardName: "Delivery",
          workspaceName: "Product",
          clientName: "Invite Org",
          role: "editor",
          assignedItemsOnly: false,
          expiresAt: null,
          boards: [{ boardId: "board-1", boardName: "Delivery", workspaceName: "Product", role: "editor", assignedItemsOnly: false }],
        });
      }
      if (url.endsWith("/auth/request-email-verification")) {
        if (accountExists) return response({ code: "ACCOUNT_EXISTS", message: "Sign in to accept the invite." }, false, 409);
        return response({ ok: true });
      }
      if (url.endsWith("/auth/signup")) {
        if (accountExists) return response({ code: "ACCOUNT_EXISTS", message: "Sign in to accept the invite." }, false, 409);
        return response({ ...authResponse, user: { ...authResponse.user, boardInviteRedirect } });
      }
      return response({}, false, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    await TestBed.configureTestingModule({
      imports: [SignupPage],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              queryParamMap: {
                get: (key: string) => key === "invite" ? inviteToken : key === "boardInviteToken" ? boardInviteToken : null,
              },
            },
          },
        },
        { provide: Router, useValue: { navigateByUrl } },
        { provide: AuthService, useValue: { setSession } },
        { provide: ThemeService, useValue: { theme: vi.fn(() => "dark"), setTheme: vi.fn() } },
      ],
    }).compileComponents();
  });

  async function createPage() {
    fixture = TestBed.createComponent(SignupPage);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  function fillValidForm() {
    const page = fixture.componentInstance;
    page.orgName.set("Acme");
    page.displayName.set("Owner");
    page.email.set("owner@example.com");
    page.password.set("Abc12345");
    page.confirmPassword.set("Abc12345");
  }

  it("requires a challenge before emailing a code and preserves signup readiness after resetting it", async () => {
    turnstileSiteKey = "site-key";
    emailVerificationEnabled = true;
    const render = vi.fn((_container: HTMLElement, _options: { callback(token: string): void }) => "signup-widget");
    const reset = vi.fn();
    vi.stubGlobal("turnstile", { render, reset });
    await createPage();
    fillValidForm();
    await vi.waitFor(() => expect(render).toHaveBeenCalled());

    await fixture.componentInstance.submit(submitEvent());
    expect(fixture.componentInstance.error()).toBe("Complete the security check to continue.");
    expect(fetchMock.mock.calls.some(([input]) => urlFromRequest(input as RequestInfo | URL).endsWith("/auth/request-email-verification"))).toBe(false);

    const options = render.mock.calls[0]![1];
    options.callback("signup-token");
    await fixture.whenStable();
    expect(fixture.componentInstance.error()).toBeNull();
    expect(fixture.componentInstance.turnstileReady()).toBe(true);
    await fixture.componentInstance.submit(submitEvent());

    const request = fetchMock.mock.calls.find(([input]) => urlFromRequest(input as RequestInfo | URL).endsWith("/auth/request-email-verification"));
    expect(JSON.parse((request?.[1] as RequestInit).body as string).turnstileToken).toBe("signup-token");
    expect(fixture.componentInstance.step()).toBe("code");
    expect(fixture.componentInstance.turnstileToken()).toBeNull();
    expect(fixture.componentInstance.turnstileReady()).toBe(true);
    expect(reset).toHaveBeenCalledWith("signup-widget");
  });

  it("creates the account directly when email verification is disabled", async () => {
    await createPage();
    fillValidForm();

    await fixture.componentInstance.submit(submitEvent());

    const urls = fetchMock.mock.calls.map(([input]) => urlFromRequest(input as RequestInfo | URL));
    expect(urls.some((url) => url.endsWith("/auth/signup"))).toBe(true);
    expect(urls.some((url) => url.endsWith("/auth/request-email-verification"))).toBe(false);
    expect(setSession).toHaveBeenCalledWith("access-token", { ...authResponse.user, boardInviteRedirect: null });
    expect(navigateByUrl).toHaveBeenCalledWith("/");
    const signupCall = fetchMock.mock.calls.find(([input]) => urlFromRequest(input as RequestInfo | URL).endsWith("/auth/signup"));
    expect(JSON.parse((signupCall?.[1] as RequestInit).body as string)).toMatchObject({
      analyticsAttribution: { source: "direct", medium: "none", campaign: "none" },
    });
  });

  it("shows legal links only for hosted signups", async () => {
    await createPage();
    await vi.waitFor(() => expect(fixture.componentInstance.deploymentMode()).toBe("hosted"));
    let element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.legal-consent a[href="https://www.kanera.app/terms"]')).not.toBeNull();
    expect(element.querySelector('.legal-consent a[href="https://www.kanera.app/privacy"]')).not.toBeNull();

    fixture.destroy();
    deploymentMode = "self_hosted";
    await createPage();
    await vi.waitFor(() => expect(fixture.componentInstance.deploymentMode()).toBe("self_hosted"));
    element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector(".legal-consent")).toBeNull();
  });

  it("shows the same device-scoped appearance control as account settings", async () => {
    await createPage();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain("Appearance");
    expect(element.textContent).toContain("Choose the theme used on this device.");
    expect(element.querySelectorAll(".theme-option")).toHaveLength(2);
  });

  it("shows the environment banner for non-production environments", async () => {
    kaneraEnvironment = "staging";
    await createPage();
    await vi.waitFor(() => expect(fixture.componentInstance.environmentBannerLabel()).toBe("Staging"));

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector(".auth-env-banner")?.textContent).toContain("Staging");
  });

  it("requests a code first when email verification is enabled", async () => {
    emailVerificationEnabled = true;
    await createPage();
    await vi.waitFor(() => expect(fixture.componentInstance.emailVerificationEnabled()).toBe(true));
    fillValidForm();

    await fixture.componentInstance.submit(submitEvent());

    const urls = fetchMock.mock.calls.map(([input]) => urlFromRequest(input as RequestInfo | URL));
    expect(urls.some((url) => url.endsWith("/auth/request-email-verification"))).toBe(true);
    expect(urls.some((url) => url.endsWith("/auth/signup"))).toBe(false);
    expect(fixture.componentInstance.step()).toBe("code");
  });

  it("shows a closed state when public signups are disabled", async () => {
    signupsEnabled = false;
    await createPage();
    await vi.waitFor(() => expect(fixture.componentInstance.publicSignupBlocked()).toBe(true));

    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain("Signups are currently closed.");
    expect(element.querySelector("form")).toBeNull();

    await fixture.componentInstance.submit(submitEvent());
    const urls = fetchMock.mock.calls.map(([input]) => urlFromRequest(input as RequestInfo | URL));
    expect(urls.some((url) => url.endsWith("/auth/signup"))).toBe(false);
  });

  it("keeps the signup form available for organisation invites when public signups are disabled", async () => {
    signupsEnabled = false;
    inviteToken = "invite-token";
    await createPage();
    await vi.waitFor(() => expect(fixture.componentInstance.publicSignupBlocked()).toBe(false));

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector("form")).not.toBeNull();
    expect(element.textContent).toContain("Your name");
  });

  it("passes invite tokens when requesting a verification code", async () => {
    emailVerificationEnabled = true;
    inviteToken = "invite-token";
    boardInviteToken = "board-token";
    await createPage();
    await vi.waitFor(() => expect(fixture.componentInstance.emailVerificationEnabled()).toBe(true));
    fillValidForm();

    await fixture.componentInstance.submit(submitEvent());

    const call = fetchMock.mock.calls.find(([input]) => urlFromRequest(input as RequestInfo | URL).endsWith("/auth/request-email-verification"));
    expect(call).toBeTruthy();
    const init = call![1] as RequestInit;
    expect(typeof init.body).toBe("string");
    expect(JSON.parse(init.body as string)).toMatchObject({
      email: "owner@example.com",
      inviteToken: "invite-token",
      boardInviteToken: "board-token",
    });
  });

  it("redirects an existing invitee account to the authenticated invite flow", async () => {
    inviteToken = "existing-account-token";
    accountExists = true;
    await createPage();
    fillValidForm();

    await fixture.componentInstance.submit(submitEvent());

    expect(navigateByUrl).toHaveBeenCalledWith("/invite?token=existing-account-token");
    expect(fixture.componentInstance.error()).toBeNull();
  });

  it("redirects before verification when the invite email already has an account", async () => {
    emailVerificationEnabled = true;
    inviteToken = "verified-existing-token";
    accountExists = true;
    await createPage();
    await vi.waitFor(() => expect(fixture.componentInstance.emailVerificationEnabled()).toBe(true));
    fillValidForm();

    await fixture.componentInstance.submit(submitEvent());

    expect(navigateByUrl).toHaveBeenCalledWith("/invite?token=verified-existing-token");
    expect(fixture.componentInstance.step()).toBe("details");
  });

  it("prefills and locks the invited email while hiding organisation name", async () => {
    boardInviteToken = "board-token";
    await createPage();
    await vi.waitFor(() => expect(fixture.componentInstance.email()).toBe("owner@example.com"));
    await fixture.whenStable();

    const element = fixture.nativeElement as HTMLElement;
    const email = element.querySelector<HTMLInputElement>("#email");
    expect(email?.value).toBe("owner@example.com");
    expect(email?.readOnly).toBe(true);
    expect(element.querySelector("#cname")).toBeNull();
    expect(element.textContent).toContain("Delivery");
    expect(element.textContent).toContain("Invite Org");
  });

  it("keeps the invite token when the lookup fails transiently", async () => {
    boardInviteToken = "board-token";
    boardLookupStatus = 429;
    await createPage();
    await vi.waitFor(() => expect(fixture.componentInstance.boardInviteNotice()).not.toBeNull());

    // A rate limit or network blip must not downgrade the flow to a disconnected plain signup:
    // the token still travels with the submission and the API enforces the invited-email match.
    expect(fixture.componentInstance.boardInviteToken()).toBe("board-token");
    expect(fixture.componentInstance.boardInvite()).toBeNull();
  });

  it("drops the invite token only when the invitation no longer exists", async () => {
    boardInviteToken = "board-token";
    boardLookupStatus = 404;
    await createPage();
    await vi.waitFor(() => expect(fixture.componentInstance.boardInviteNotice()).not.toBeNull());

    expect(fixture.componentInstance.boardInviteToken()).toBeNull();
    expect(fixture.componentInstance.boardInviteNotice()).toContain("revoked or expired");
  });

  it("routes an existing board invitee through login with the token", async () => {
    boardInviteToken = "board-token";
    accountExists = true;
    await createPage();
    fillValidForm();

    await fixture.componentInstance.submit(submitEvent());

    expect(navigateByUrl).toHaveBeenCalledWith(
      "/login?returnUrl=%2Fboard-invite%3Ftoken%3Dboard-token",
    );
  });

  it("lands on the redeemed board returned by signup", async () => {
    boardInviteToken = "board-token";
    boardInviteRedirect = "/b/board-1";
    await createPage();
    fillValidForm();

    await fixture.componentInstance.submit(submitEvent());

    expect(navigateByUrl).toHaveBeenCalledWith("/b/board-1");
  });
});

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

function urlFromRequest(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function submitEvent(): Event {
  return { preventDefault: vi.fn() } as unknown as Event;
}
