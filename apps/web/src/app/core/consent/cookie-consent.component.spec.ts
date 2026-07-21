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

  it("starts analytics off and keeps settings available after rejection", () => {
    const consent = TestBed.inject(CookieConsentService);
    consent.configure(true);
    const fixture = TestBed.createComponent(CookieConsentComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector(".consent-banner")?.textContent).toContain("Analytics stays off unless you accept it");
    expect(root.textContent).not.toContain("Marketing");
    (root.querySelector("button.secondary") as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(consent.choice()).toMatchObject({ analytics: false, marketing: false });
    expect(root.querySelector(".consent-settings")?.textContent).toContain("Cookie settings");
  });
});
