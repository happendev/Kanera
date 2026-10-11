import { describe, expect, it } from "vitest";
import { parseTimeInput, sanitizeTimeInput, stepTime } from "./reminder-time.util";

describe("parseTimeInput", () => {
  it.each([
    ["14:30", 14 * 60 + 30],
    ["1430", 14 * 60 + 30],
    ["9", 9 * 60],
    ["09:05", 9 * 60 + 5],
    ["9am", 9 * 60],
    ["2:30 pm", 14 * 60 + 30],
    ["2.30p", 14 * 60 + 30],
    ["12am", 0],
    ["12pm", 12 * 60],
    ["12:15", 12 * 60 + 15],
  ])("reads %s", (text, minutes) => {
    expect(parseTimeInput(text)).toBe(minutes);
  });

  it.each(["", "24:00", "9:60", "13pm", "0am", "tomorrow", "9:5"])("rejects %s", (text) => {
    expect(parseTimeInput(text)).toBeNull();
  });
});

describe("sanitizeTimeInput", () => {
  it("drops characters that cannot be part of a time and caps the length", () => {
    expect(sanitizeTimeInput("-110")).toBe("110");
    expect(sanitizeTimeInput("9x:3!0")).toBe("9:30");
    expect(sanitizeTimeInput("2:30 PM")).toBe("2:30 PM");
    expect(sanitizeTimeInput("12:30 pm and more")).toBe("12:30 pm");
  });
});

describe("stepTime", () => {
  it("snaps to the next quarter hour instead of adding a fixed amount", () => {
    expect(stepTime(9 * 60 + 7, 1)).toBe(9 * 60 + 15);
    expect(stepTime(9 * 60 + 7, -1)).toBe(9 * 60);
    expect(stepTime(9 * 60, 1)).toBe(9 * 60 + 15);
    expect(stepTime(9 * 60, -1)).toBe(8 * 60 + 45);
  });

  it("wraps around midnight", () => {
    expect(stepTime(23 * 60 + 50, 1)).toBe(0);
    expect(stepTime(5, -1)).toBe(0);
    expect(stepTime(0, -1)).toBe(23 * 60 + 45);
  });
});
