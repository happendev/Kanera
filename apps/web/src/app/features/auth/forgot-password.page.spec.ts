import { provideZonelessChangeDetection, signal } from "@angular/core";
import type { ComponentFixture } from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import { ActivatedRoute } from "@angular/router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeService } from "../../core/theme/theme.service";
import { ForgotPasswordPage } from "./forgot-password.page";

describe("ForgotPasswordPage", () => {
  let fixture: ComponentFixture<ForgotPasswordPage>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let turnstileOptions: { callback: (token: string) => void } | null;
  let turnstileSiteKey: string | null;

  beforeEach(async () => {
    turnstileSiteKey = null;
    turnstileOptions = null;
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlFromRequest(input);
      if (url.endsWith("/auth/config")) return response({ turnstileSiteKey });
      if (url.endsWith("/auth/forgot-password")) return response({ ok: true });
      return response({}, false, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("turnstile", {
      render: vi.fn((_container: HTMLElement, options: { callback: (token: string) => void }) => {
        turnstileOptions = options;
        return "widget-1";
      }),
      reset: vi.fn(),
    });

    await TestBed.configureTestingModule({
      imports: [ForgotPasswordPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ActivatedRoute, useValue: {} },
        { provide: ThemeService, useValue: { theme: signal("dark") } },
      ],
    }).compileComponents();
  });

  async function createPage() {
    fixture = TestBed.createComponent(ForgotPasswordPage);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  it("submits a Turnstile token when hosted auth config provides a site key", async () => {
    turnstileSiteKey = "site-key";
    await createPage();
    await vi.waitFor(() => expect(turnstileOptions).not.toBeNull());
    turnstileOptions!.callback("turnstile-token");
    fixture.componentInstance.email.set(" owner@example.com ");

    await fixture.componentInstance.submit(submitEvent());

    const forgotCall = fetchMock.mock.calls.find(([input]) => urlFromRequest(input as RequestInfo | URL).endsWith("/auth/forgot-password"));
    expect(forgotCall).toBeTruthy();
    expect(JSON.parse((forgotCall![1] as RequestInit).body as string)).toEqual({
      email: "owner@example.com",
      turnstileToken: "turnstile-token",
    });
  });

  it("requires the security challenge before posting in hosted mode", async () => {
    turnstileSiteKey = "site-key";
    await createPage();
    await vi.waitFor(() => expect(turnstileOptions).not.toBeNull());
    fixture.componentInstance.email.set("owner@example.com");

    await fixture.componentInstance.submit(submitEvent());

    expect(fixture.componentInstance.error()).toBe("Complete the security check to continue.");
    expect(fetchMock.mock.calls.some(([input]) => urlFromRequest(input as RequestInfo | URL).endsWith("/auth/forgot-password"))).toBe(false);
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
