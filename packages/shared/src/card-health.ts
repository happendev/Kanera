export const CARD_INACTIVE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

export type BoardWorkRiskMetrics = {
  active: number;
  overdue: number;
  unassigned: number;
  inactive: number;
};

export type BoardWorkRiskLevel = "noActiveWork" | "onTrack" | "needsAttention" | "atRisk";

export type BoardWorkRiskSignal = {
  kind: "overdue" | "unassigned" | "inactive";
  count: number;
};

export type BoardWorkRiskAssessment = {
  level: BoardWorkRiskLevel;
  label: "No active work" | "On track" | "Needs attention" | "At risk";
  summary: string;
  signals: BoardWorkRiskSignal[];
};

export function isCardInactive(updatedAt: Date | string, now = Date.now()): boolean {
  const timestamp = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
  return Number.isFinite(timestamp) && now - timestamp >= CARD_INACTIVE_AFTER_MS;
}

export function boardWorkRisk(metrics: BoardWorkRiskMetrics): BoardWorkRiskAssessment {
  const active = Math.max(0, metrics.active);
  if (active === 0) {
    return {
      level: "noActiveWork",
      label: "No active work",
      summary: "No active work to assess",
      signals: [],
    };
  }

  const count = (value: number) => Math.min(active, Math.max(0, value));
  const overdue = count(metrics.overdue);
  const unassigned = count(metrics.unassigned);
  const inactive = count(metrics.inactive);
  const ratio = (value: number) => value / active;
  const signals: BoardWorkRiskSignal[] = [
    { kind: "overdue", count: overdue },
    { kind: "unassigned", count: unassigned },
    { kind: "inactive", count: inactive },
  ].filter((signal) => signal.count > 0) as BoardWorkRiskSignal[];

  // Counts prevent a large backlog from hiding concrete delivery problems, while ratios escalate a
  // small board whose work is broadly affected. These are triage rules, not a claim to know scope,
  // capacity, dependencies, or stakeholder confidence.
  const atRisk = ratio(overdue) >= 0.5
    || overdue >= 5
    || (active >= 2 && ratio(unassigned) >= 0.75)
    || (active >= 2 && ratio(inactive) >= 0.75);
  const needsAttention = overdue > 0
    || ratio(unassigned) >= 0.25
    || unassigned >= 5
    || ratio(inactive) >= 0.25
    || inactive >= 5;
  const level: BoardWorkRiskLevel = atRisk ? "atRisk" : needsAttention ? "needsAttention" : "onTrack";
  const label = level === "atRisk" ? "At risk" : level === "needsAttention" ? "Needs attention" : "On track";
  const summary = signals.length
    ? signals.map((signal) => `${signal.count} ${signal.kind}`).join(" · ")
    : "No overdue or material ownership/activity risks";

  return { level, label, summary, signals };
}
