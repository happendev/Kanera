import { Location } from "@angular/common";
import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { ActivatedRoute, Router } from "@angular/router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../../core/auth/auth.service";
import { ThemeService } from "../../core/theme/theme.service";
import { ProviderCallbackPage } from "./provider-callback.page";

// Failure this catches: installing the session reloads the page when the account's language differs
// from the device's. If the address bar still holds ?h= at that moment, the reload redeems a used
// handoff and shows "This sign-in has expired" although the sign-in succeeded. No E2E stack runs a
// provider sign-in with a mismatched language, so only this ordering check sees it.
describe("ProviderCallbackPage", () => {
  const order: string[] = [];
  let navigateByUrl: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    order.length = 0;
    navigateByUrl = vi.fn(async () => true);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      accessToken: "access-token",
      returnUrl: "/b/board-1",
      user: {
        id: "user-1", clientId: "client-1", email: "owner@example.com", displayName: "Owner", avatarUrl: null,
        orgName: "Acme", logoUrl: null, deploymentMode: "hosted", kaneraEnvironment: "production",
        hasWorkspace: true, role: "owner", timezone: "UTC", locale: "en-GB",
        storageUsage: { usedBytes: 0, quotaBytes: null, remainingBytes: null, limited: false, maxFileBytes: 104_857_600 },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await TestBed.configureTestingModule({
      imports: [ProviderCallbackPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ActivatedRoute, useValue: {} },
        { provide: Router, useValue: { navigateByUrl, createUrlTree: () => ({}), serializeUrl: () => "/login", events: { subscribe: () => ({ unsubscribe() {} }) } } },
        { provide: Location, useValue: { replaceState: (url: string) => order.push(`replace ${url}`) } },
        { provide: AuthService, useValue: { setSession: () => order.push("setSession") } },
        { provide: ThemeService, useValue: { theme: signal("dark"), isDark: signal(true) } },
      ],
    }).compileComponents();
  });

  it("leaves the handoff URL before installing the session", async () => {
    const fixture = TestBed.createComponent(ProviderCallbackPage);
    fixture.componentRef.setInput("h", "handoff-1");
    await fixture.componentInstance.ngOnInit();

    expect(order).toEqual(["replace /b/board-1", "setSession"]);
    expect(navigateByUrl).toHaveBeenCalledWith("/b/board-1", { replaceUrl: true });
  });
});
