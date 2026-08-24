import { describe, expect, it } from "vitest";
import { boardWorkRisk, isCardInactive } from "@kanera/shared/card-health";

describe("board health", () => {
  it("escalates severe risks independently instead of blending them into a score", () => {
    expect(boardWorkRisk({ active: 10, overdue: 0, unassigned: 0, inactive: 10 }).level).toBe("atRisk");
    expect(boardWorkRisk({ active: 10, overdue: 10, unassigned: 0, inactive: 0 }).level).toBe("atRisk");
    expect(boardWorkRisk({ active: 10, overdue: 0, unassigned: 10, inactive: 0 }).level).toBe("atRisk");
  });

  it("does not let a large backlog hide overdue work", () => {
    expect(boardWorkRisk({ active: 1, overdue: 1, unassigned: 0, inactive: 0 }).level).toBe("atRisk");
    expect(boardWorkRisk({ active: 100, overdue: 1, unassigned: 0, inactive: 0 }).level).toBe("needsAttention");
  });

  it("returns a distinct unscored state when there is no active work", () => {
    expect(boardWorkRisk({ active: 0, overdue: 0, unassigned: 0, inactive: 0 })).toEqual({
      level: "noActiveWork",
      label: "No active work",
      summary: "No active work to assess",
      signals: [],
    });
  });

  it("keeps lower-volume hygiene signals visible without overstating them", () => {
    expect(boardWorkRisk({ active: 10, overdue: 0, unassigned: 1, inactive: 1 })).toMatchObject({
      level: "onTrack",
      summary: "1 unassigned · 1 inactive",
    });
    expect(boardWorkRisk({ active: 10, overdue: 0, unassigned: 3, inactive: 0 }).level).toBe("needsAttention");
  });

  it("clamps invalid counts to the active-card population", () => {
    expect(boardWorkRisk({ active: 2, overdue: 20, unassigned: -1, inactive: 0 })).toMatchObject({
      level: "atRisk",
      summary: "2 overdue",
    });
  });

  it("excludes workspace-disabled signals from the health status and summary", () => {
    expect(boardWorkRisk(
      { active: 10, overdue: 10, unassigned: 0, inactive: 0 },
      { overdue: false, unassigned: true, inactive: true },
    )).toMatchObject({
      level: "onTrack",
      signals: [],
    });
  });

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
