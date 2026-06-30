import { provideZonelessChangeDetection, signal } from "@angular/core";
import type { ComponentFixture } from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import { ActivatedRoute, Router } from "@angular/router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../../core/auth/auth.service";
import { ThemeService } from "../../core/theme/theme.service";
import { LoginPage } from "./login.page";

describe("LoginPage", () => {
  let fixture: ComponentFixture<LoginPage>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let setSession: ReturnType<typeof vi.fn>;
  let navigateByUrl: ReturnType<typeof vi.fn>;
  let kaneraEnvironment: "development" | "test" | "staging" | "production";
  let loginOk: boolean;
  let loginThrows: boolean;

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
      hasWorkspace: true,
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
    kaneraEnvironment = "production";
    loginOk = true;
    loginThrows = false;
    setSession = vi.fn();
    navigateByUrl = vi.fn();
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlFromRequest(input);
      if (url.endsWith("/auth/config")) {
        return response({ kaneraEnvironment });
      }
      if (url.endsWith("/auth/login")) {
        if (loginThrows) throw new Error("network down");
        return loginOk ? response(authResponse) : response({ message: "invalid" }, false, 401);
      }
      return response({}, false, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    await TestBed.configureTestingModule({
      imports: [LoginPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ActivatedRoute, useValue: {} },
        { provide: Router, useValue: { navigateByUrl } },
        { provide: AuthService, useValue: { setSession } },
        { provide: ThemeService, useValue: { theme: signal("dark") } },
      ],
    }).compileComponents();
  });

  async function createPage() {
    fixture = TestBed.createComponent(LoginPage);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  function fillValidForm() {
    const page = fixture.componentInstance;
    page.email.set("owner@example.com");
    page.password.set("password123");
  }

  it("signs in and stores the returned session", async () => {
    await createPage();
    fillValidForm();

    await fixture.componentInstance.submit(submitEvent());

    const loginCall = fetchMock.mock.calls.find(([input]) => urlFromRequest(input as RequestInfo | URL).endsWith("/auth/login"));
    expect(loginCall).toBeTruthy();
    const init = loginCall![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body as string)).toEqual({
      email: "owner@example.com",
      password: "password123",
    });
    expect(setSession).toHaveBeenCalledWith("access-token", authResponse.user);
    expect(navigateByUrl).toHaveBeenCalledWith("/");
  });

  it("trims the email before submitting credentials", async () => {
    await createPage();
    fixture.componentInstance.email.set("  owner@example.com  ");
    fixture.componentInstance.password.set("password123");

    await fixture.componentInstance.submit(submitEvent());

    const loginCall = fetchMock.mock.calls.find(([input]) => urlFromRequest(input as RequestInfo | URL).endsWith("/auth/login"));
    expect(JSON.parse((loginCall![1] as RequestInit).body as string).email).toBe("owner@example.com");
  });

  it("validates email and password before calling login", async () => {
    await createPage();
    fixture.componentInstance.email.set("not-an-email");
    fixture.componentInstance.password.set("password123");

    await fixture.componentInstance.submit(submitEvent());

    expect(fixture.componentInstance.error()).toBe("Enter a valid email address.");
    expect(fetchMock.mock.calls.some(([input]) => urlFromRequest(input as RequestInfo | URL).endsWith("/auth/login"))).toBe(false);

    fixture.componentInstance.email.set("owner@example.com");
    fixture.componentInstance.password.set("");
    await fixture.componentInstance.submit(submitEvent());

    expect(fixture.componentInstance.error()).toBe("Password is required.");
    expect(fetchMock.mock.calls.some(([input]) => urlFromRequest(input as RequestInfo | URL).endsWith("/auth/login"))).toBe(false);
  });

  it("shows invalid credentials for rejected logins", async () => {
    loginOk = false;
    await createPage();
    fillValidForm();

    await fixture.componentInstance.submit(submitEvent());

    expect(fixture.componentInstance.error()).toBe("Invalid credentials");
    expect(setSession).not.toHaveBeenCalled();
    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  it("shows a connection error when login cannot reach the server", async () => {
    loginThrows = true;
    await createPage();
    fillValidForm();

    await fixture.componentInstance.submit(submitEvent());

    expect(fixture.componentInstance.error()).toBe("Unable to reach the server. Check your connection and try again.");
    expect(setSession).not.toHaveBeenCalled();
  });

  it("shows the environment banner for non-production environments", async () => {
    kaneraEnvironment = "development";
    await createPage();
    await vi.waitFor(() => expect(fixture.componentInstance.environmentBannerLabel()).toBe("Development"));
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector(".auth-env-banner")?.textContent).toContain("Development");
  });

  it("hides the environment banner in production", async () => {
    await createPage();

    expect(fixture.componentInstance.environmentBannerLabel()).toBeNull();
    expect((fixture.nativeElement as HTMLElement).querySelector(".auth-env-banner")).toBeNull();
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
