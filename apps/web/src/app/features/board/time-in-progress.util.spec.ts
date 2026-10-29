import { nextWorkingStart } from "@kanera/shared/time-in-progress";
import { describe, expect, it } from "vitest";
import { timeInProgressChip } from "./time-in-progress.util";

// 29 Oct 2026 is a Thursday.
const at = (iso: string) => Date.parse(iso);

describe("nextWorkingStart", () => {
  it("is null inside working hours, so a running clock is not called paused", () => {
    expect(nextWorkingStart(at("2026-10-29T09:00:00Z"), "UTC")).toBeNull();
    expect(nextWorkingStart(at("2026-10-29T16:59:59Z"), "UTC")).toBeNull();
  });

  it("resumes the same morning before 09:00 and the next morning after 17:00", () => {
    expect(nextWorkingStart(at("2026-10-29T06:30:00Z"), "UTC")).toBe(at("2026-10-29T09:00:00Z"));
    expect(nextWorkingStart(at("2026-10-29T17:00:00Z"), "UTC")).toBe(at("2026-10-30T09:00:00Z"));
  });

  it("skips the weekend from Friday evening", () => {
    expect(nextWorkingStart(at("2026-10-30T18:00:00Z"), "UTC")).toBe(at("2026-11-02T09:00:00Z"));
    expect(nextWorkingStart(at("2026-11-01T12:00:00Z"), "UTC")).toBe(at("2026-11-02T09:00:00Z"));
  });

  it("reads working hours in the workspace's zone", () => {
    // 23:15 UTC is 01:15 Friday in Johannesburg: paused until 09:00 there, 07:00 UTC.
    expect(nextWorkingStart(at("2026-10-29T23:15:00Z"), "Africa/Johannesburg")).toBe(at("2026-10-30T07:00:00Z"));
    // 21:00 UTC is 14:00 in Los Angeles: counting.
    expect(nextWorkingStart(at("2026-10-29T21:00:00Z"), "America/Los_Angeles")).toBeNull();
  });
});

describe("timeInProgressChip", () => {
  it("marks a clock started after hours as paused at 0m rather than ticking", () => {
    const chip = timeInProgressChip({ inProgressSince: "2026-10-29T21:00:00Z", inProgressSeconds: 0, completedAt: null }, at("2026-10-29T23:15:00Z"), 0, "UTC");
    expect(chip).toMatchObject({ running: true, paused: true, text: "0m" });
    expect(chip?.resumesAt).toBeTruthy();
    expect(chip?.label).toContain("paused outside working hours");
  });

  it("is not paused while counting, nor once stopped", () => {
    const now = at("2026-10-29T12:00:00Z");
    const running = timeInProgressChip({ inProgressSince: "2026-10-29T10:00:00Z", completedAt: null }, now, 0, "UTC");
    expect(running).toMatchObject({ running: true, paused: false, resumesAt: null, text: "2h" });
    const stopped = timeInProgressChip({ inProgressSince: null, inProgressSeconds: 3600 }, at("2026-10-29T23:00:00Z"), 0, "UTC");
    expect(stopped).toMatchObject({ running: false, paused: false });
  });
});
