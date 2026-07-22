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

    expect(root.querySelector(".consent-banner")?.textContent).toContain("Analytics stays off unless you accept it");
    expect(root.querySelector(".consent-banner")?.textContent).toContain("progress through registration and subscription");
    expect(root.textContent).not.toContain("Marketing");
    (root.querySelector("button.secondary") as HTMLButtonElement).click();
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
    expect(dialog).toContain("subscription starts, renewals, resumptions, cancellations, and plan or seat-band changes");
    expect(dialog).toContain("exclude payment-method details and workspace content");
  });
});
