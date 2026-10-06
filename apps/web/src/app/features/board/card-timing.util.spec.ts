import { describe, expect, it } from "vitest";
import { isCardInactive } from "@kanera/shared/card-timing";

describe("card inactivity", () => {
  it("uses the same fourteen-day inactivity boundary as card indicators", () => {
    const now = new Date("2026-08-19T12:00:00.000Z").getTime();
    expect(isCardInactive("2026-08-05T12:00:00.000Z", now)).toBe(true);
    expect(isCardInactive("2026-08-05T12:00:00.001Z", now)).toBe(false);
  });

  it("uses a workspace-specific inactivity boundary", () => {
    const now = new Date("2026-08-19T12:00:00.000Z").getTime();
    expect(isCardInactive("2026-08-09T12:00:00.000Z", now, 10)).toBe(true);
    expect(isCardInactive("2026-08-09T12:00:00.001Z", now, 10)).toBe(false);
  });
});
