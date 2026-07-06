import { describe, expect, it } from "vitest";
import { mfaQrDataUrl } from "./mfa-qr";

describe("mfaQrDataUrl", () => {
  it("creates an SVG data URL without exposing the otpauth URI as SVG text", () => {
    const uri = "otpauth://totp/Kanera:test@example.com?secret=ABCDEFGHIJKLMNOP&issuer=Kanera";
    const dataUrl = mfaQrDataUrl(uri);
    const svg = decodeURIComponent(dataUrl.slice(dataUrl.indexOf(",") + 1));

    expect(dataUrl).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(svg).toContain("<svg");
    expect(svg).not.toContain(uri);
  });
});
