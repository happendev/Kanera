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
  let signupsEnabled: boolean;
  let kaneraEnvironment: "development" | "test" | "staging" | "production";
  let inviteToken: string | null;
  let boardInviteToken: string | null;

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
    signupsEnabled = true;
    kaneraEnvironment = "production";
    inviteToken = null;
    boardInviteToken = null;
    setSession = vi.fn();
    navigateByUrl = vi.fn();
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlFromRequest(input);
      if (url.endsWith("/auth/config")) {
        return response({ emailVerificationEnabled, signupsEnabled, turnstileSiteKey: null, kaneraEnvironment });
      }
      if (url.includes("/invites/lookup")) {
        return response({ orgName: "Invite Org", orgRole: "member", workspaces: [] });
      }
      if (url.endsWith("/auth/request-email-verification")) {
        return response({ ok: true });
      }
      if (url.endsWith("/auth/signup")) {
        return response(authResponse);
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

  it("creates the account directly when email verification is disabled", async () => {
    await createPage();
    fillValidForm();

    await fixture.componentInstance.submit(submitEvent());

    const urls = fetchMock.mock.calls.map(([input]) => urlFromRequest(input as RequestInfo | URL));
    expect(urls.some((url) => url.endsWith("/auth/signup"))).toBe(true);
    expect(urls.some((url) => url.endsWith("/auth/request-email-verification"))).toBe(false);
    expect(setSession).toHaveBeenCalledWith("access-token", authResponse.user);
    expect(navigateByUrl).toHaveBeenCalledWith("/");
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
