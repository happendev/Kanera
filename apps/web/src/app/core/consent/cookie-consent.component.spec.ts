import { TestBed } from "@angular/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CookieConsentComponent } from "./cookie-consent.component";
import { CookieConsentService, KANERA_CONSENT_COOKIE } from "./cookie-consent.service";

describe("CookieConsentComponent", () => {
  beforeEach(async () => {
    document.cookie = `${KANERA_CONSENT_COOKIE}=; Max-Age=0; Path=/`;
    localStorage.clear();
    sessionStorage.clear();
    await TestBed.configureTestingModule({ imports: [CookieConsentComponent] }).compileComponents();
  });

  afterEach(() => {
    document.cookie = `${KANERA_CONSENT_COOKIE}=; Max-Age=0; Path=/`;
    TestBed.resetTestingModule();
  });

  it("starts analytics off and removes the floating control after rejection", () => {
    const consent = TestBed.inject(CookieConsentService);
    consent.configure(true);
    const fixture = TestBed.createComponent(CookieConsentComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector(".consent-banner")?.textContent).toContain("They stay off unless you accept.");
    expect(root.textContent).not.toContain("Marketing");
    (root.querySelector("button[aria-label='Reject non-essential']") as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(consent.choice()).toMatchObject({ analytics: false, marketing: false });
    expect(root.querySelector(".consent-settings")).toBeNull();
  });

  it("opens preferences when another settings screen requests them", () => {
    const consent = TestBed.inject(CookieConsentService);
    consent.configure(true);
    consent.save(false);
    const fixture = TestBed.createComponent(CookieConsentComponent);
    fixture.detectChanges();

    consent.openSettings();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector(".consent-dialog")).not.toBeNull();
  });

  it("explains commercial lifecycle analytics in detailed preferences", () => {
    const consent = TestBed.inject(CookieConsentService);
    consent.configure(true);
    const fixture = TestBed.createComponent(CookieConsentComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    (root.querySelector("button.text") as HTMLButtonElement).click();
    fixture.detectChanges();

    const dialog = root.querySelector(".consent-dialog")?.textContent ?? "";
    expect(dialog).toContain("Analytics cookies");
    expect(dialog).toContain("Separate server-side analytics");
    expect(dialog).toContain("subscription starts, renewals, resumptions, cancellations, and plan or seat-count changes");
    expect(dialog).toContain("exclude payment-method details and workspace content");
  });

  it("turns analytics on without a banner outside opt-in regions", () => {
    const consent = TestBed.inject(CookieConsentService);
    consent.configure(true, false);
    const fixture = TestBed.createComponent(CookieConsentComponent);
    fixture.detectChanges();

    expect(consent.analyticsAllowed()).toBe(true);
    expect(document.cookie).toContain(KANERA_CONSENT_COOKIE);
    expect((fixture.nativeElement as HTMLElement).querySelector(".consent-banner")).toBeNull();
  });

  it("keeps an earlier rejection outside opt-in regions", () => {
    const consent = TestBed.inject(CookieConsentService);
    consent.save(false);
    consent.configure(true, false);

    expect(consent.analyticsAllowed()).toBe(false);
  });
});
