import { describe, expect, it } from "vitest";
import { timeZoneOffsetMinutes } from "../../../shared/date-format";
import { formatUtcOffset, timeZonePickerGroups } from "./time-zone-options";

// Failure modes: half- and quarter-hour offsets truncated to the hour; western zones signed as east;
// daylight saving ignored; an unknown saved zone throwing or vanishing from the list; the list not
// ordered west to east; labels without the offset, with IANA underscores, or under a renamed zone's
// old name, so "new york" or "kolkata" finds nothing.
describe("time zone picker options", () => {
  const january = new Date("2026-01-15T12:00:00Z");
  const july = new Date("2026-07-15T12:00:00Z");

  it("reads offsets in minutes east, following daylight saving", () => {
    expect(timeZoneOffsetMinutes("UTC", january)).toBe(0);
    expect(timeZoneOffsetMinutes("Asia/Kolkata", january)).toBe(330);
    expect(timeZoneOffsetMinutes("Asia/Kathmandu", january)).toBe(345);
    expect(timeZoneOffsetMinutes("America/St_Johns", january)).toBe(-210);
    expect(timeZoneOffsetMinutes("America/New_York", january)).toBe(-300);
    expect(timeZoneOffsetMinutes("America/New_York", july)).toBe(-240);
    expect(timeZoneOffsetMinutes("Not/AZone", january)).toBeNull();
  });

  it("formats offsets with a searchable ASCII sign", () => {
    expect(formatUtcOffset(0)).toBe("UTC+00:00");
    expect(formatUtcOffset(330)).toBe("UTC+05:30");
    expect(formatUtcOffset(-210)).toBe("UTC-03:30");
    expect(formatUtcOffset(840)).toBe("UTC+14:00");
  });

  it("orders zones west to east, labels them with their offset, and keeps an unknown saved zone", () => {
    const [group] = timeZonePickerGroups("Europe/London", january);
    const options = group!.options;
    const offsets = options.map((option) => Number(/UTC([+-]\d{2}):(\d{2})/.exec(option.label)![1]) * 60);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(options.find((option) => option.id === "America/New_York")?.label).toBe("(UTC-05:00) America/New York");
    // Whichever name this runtime lists (Chromium and Node still say Calcutta), it reads as Kolkata.
    const kolkata = options.findIndex((option) => option.label === "(UTC+05:30) Asia/Kolkata");
    const kathmandu = options.findIndex((option) => option.label === "(UTC+05:45) Asia/Kathmandu");
    expect(kolkata).toBeGreaterThan(-1);
    expect(kolkata).toBeLessThan(kathmandu);

    const saved = timeZonePickerGroups("Legacy/Zone", january)[0]!.options.find((option) => option.id === "Legacy/Zone");
    expect(saved?.label).toBe("(UTC+00:00) Legacy/Zone");

    // Saved under its current name where the runtime lists the old one: one row, keeping the saved id.
    const kolkataRows = timeZonePickerGroups("Asia/Kolkata", january)[0]!.options.filter((option) => option.label === "(UTC+05:30) Asia/Kolkata");
    expect(kolkataRows.map((option) => option.id)).toEqual(["Asia/Kolkata"]);
  });
});
