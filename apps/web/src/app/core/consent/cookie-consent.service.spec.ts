import { describe, expect, it } from "vitest";
import { KANERA_CONSENT_VERSION, parseConsentChoice } from "./cookie-consent.service";

function encodedChoice(updatedAt: string, analytics = true): string {
  return encodeURIComponent(JSON.stringify({
    version: KANERA_CONSENT_VERSION,
    necessary: true,
    analytics,
    marketing: false,
    updatedAt,
  }));
}

describe("shared cookie consent", () => {
  it("accepts a current versioned choice for up to six months", () => {
    const now = Date.parse("2026-07-21T12:00:00.000Z");
    expect(parseConsentChoice(encodedChoice("2026-07-20T12:00:00.000Z"), now)?.analytics).toBe(true);
    expect(parseConsentChoice(encodedChoice("2026-01-01T00:00:00.000Z"), now)).toBeNull();
  });

  it("rejects malformed, future, or differently versioned consent", () => {
    const now = Date.parse("2026-07-21T12:00:00.000Z");
    expect(parseConsentChoice("not-json", now)).toBeNull();
    expect(parseConsentChoice(encodedChoice("2026-07-22T12:00:00.000Z"), now)).toBeNull();
    const wrongVersion = encodeURIComponent(JSON.stringify({ version: 2, necessary: true, analytics: true, marketing: false, updatedAt: "2026-07-21T12:00:00.000Z" }));
    expect(parseConsentChoice(wrongVersion, now)).toBeNull();
  });
});
