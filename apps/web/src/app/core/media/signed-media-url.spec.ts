import { afterEach, describe, expect, it, vi } from "vitest";
import { isSignedMediaUrlExpired, visibleSignedMediaUrl } from "./signed-media-url";

// All timestamps are anchored to a fixed "now" so the 5-minute skew window is
// deterministic regardless of when the suite runs.
const NOW = Date.parse("2026-06-26T12:00:00.000Z");
const MINUTE = 60_000;

function signed(expiryMs: number, opts: { share?: boolean } = {}): string {
  const share = opts.share ? "&s=share" : "";
  return `https://board.kanera.app/api/media/client-1/cards/card-1/cover.png?t=token&e=${expiryMs}${share}`;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("isSignedMediaUrlExpired", () => {
  it("returns false for null, empty, and non-signed URLs", () => {
    expect(isSignedMediaUrlExpired(null)).toBe(false);
    expect(isSignedMediaUrlExpired(undefined)).toBe(false);
    expect(isSignedMediaUrlExpired("")).toBe(false);
    expect(isSignedMediaUrlExpired("https://board.kanera.app/assets/logo.svg")).toBe(false);
    // A media URL without an `e=` param is not something we can reason about.
    expect(isSignedMediaUrlExpired("https://board.kanera.app/api/media/x/cover.png?t=token")).toBe(false);
  });

  it("treats a comfortably-valid token as live", () => {
    vi.useFakeTimers().setSystemTime(NOW);
    expect(isSignedMediaUrlExpired(signed(NOW + 60 * MINUTE))).toBe(false);
  });

  it("treats an already-expired token as stale", () => {
    vi.useFakeTimers().setSystemTime(NOW);
    expect(isSignedMediaUrlExpired(signed(NOW - MINUTE))).toBe(true);
  });

  it("treats a near-expiry token (within the skew window) as stale", () => {
    vi.useFakeTimers().setSystemTime(NOW);
    // 1 minute of life left is inside the 5-minute skew margin, so it would race
    // into a 404 by the time the request reaches the origin.
    expect(isSignedMediaUrlExpired(signed(NOW + MINUTE))).toBe(true);
  });
});

describe("visibleSignedMediaUrl", () => {
  it("passes through null/empty unchanged", () => {
    expect(visibleSignedMediaUrl(null)).toBeNull();
    expect(visibleSignedMediaUrl(undefined)).toBeNull();
    expect(visibleSignedMediaUrl("")).toBeNull();
  });

  it("returns non-signed URLs unchanged", () => {
    const url = "https://board.kanera.app/assets/logo.svg";
    expect(visibleSignedMediaUrl(url)).toBe(url);
  });

  it("returns a valid signed URL but suppresses an expired one", () => {
    vi.useFakeTimers().setSystemTime(NOW);
    const valid = signed(NOW + 60 * MINUTE);
    expect(visibleSignedMediaUrl(valid)).toBe(valid);
    expect(visibleSignedMediaUrl(signed(NOW - MINUTE))).toBeNull();
  });
});
