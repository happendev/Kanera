import { afterEach, describe, expect, it, vi } from "vitest";
import { analyticsRequiresOptIn } from "./consent-region";

describe("analyticsRequiresOptIn", () => {
  afterEach(() => vi.restoreAllMocks());

  const withTimeZone = (timeZone: string | undefined) =>
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone } as Intl.ResolvedDateTimeFormatOptions);

  it("asks visitors from the EEA, the UK and Switzerland", () => {
    for (const country of ["DE", "GB", "CH", "NO", "RE"]) expect(analyticsRequiresOptIn(country)).toBe(true);
  });

  it("defaults analytics on elsewhere, whatever the time zone says", () => {
    withTimeZone("Europe/London");
    for (const country of ["US", "ZA", "JP", "BR"]) expect(analyticsRequiresOptIn(country)).toBe(false);
  });

  it("falls back to the time zone when the country is unknown", () => {
    withTimeZone("Europe/Berlin");
    expect(analyticsRequiresOptIn(null)).toBe(true);
    withTimeZone("America/New_York");
    expect(analyticsRequiresOptIn(null)).toBe(false);
    withTimeZone(undefined);
    expect(analyticsRequiresOptIn(undefined)).toBe(true);
  });

  it("asks whenever Global Privacy Control is on", () => {
    Object.defineProperty(navigator, "globalPrivacyControl", { value: true, configurable: true });
    try {
      expect(analyticsRequiresOptIn("US")).toBe(true);
    } finally {
      delete (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl;
    }
  });
});
