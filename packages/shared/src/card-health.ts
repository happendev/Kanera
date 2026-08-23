import { DEFAULT_INACTIVE_CARDS_DAYS } from "./lib/workspace-defaults.js";

export type BoardWorkRiskMetrics = {
  active: number;
  overdue: number;
  unassigned: number;
  inactive: number;
};

export type BoardWorkRiskConfig = {
  overdue: boolean;
  unassigned: boolean;
  inactive: boolean;
};

export const DEFAULT_BOARD_WORK_RISK_CONFIG: BoardWorkRiskConfig = {
  overdue: true,
  unassigned: true,
  inactive: true,
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

export function isCardInactive(updatedAt: Date | string, now = Date.now(), inactiveCardsDays = DEFAULT_INACTIVE_CARDS_DAYS): boolean {
  const timestamp = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
  return Number.isFinite(timestamp) && now - timestamp >= inactiveCardsDays * 24 * 60 * 60 * 1000;
}

export function boardWorkRisk(
  metrics: BoardWorkRiskMetrics,
  config: BoardWorkRiskConfig = DEFAULT_BOARD_WORK_RISK_CONFIG,
): BoardWorkRiskAssessment {
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
    ...(config.overdue ? [{ kind: "overdue" as const, count: overdue }] : []),
    ...(config.unassigned ? [{ kind: "unassigned" as const, count: unassigned }] : []),
    ...(config.inactive ? [{ kind: "inactive" as const, count: inactive }] : []),
  ].filter((signal) => signal.count > 0) as BoardWorkRiskSignal[];

  // Counts prevent a large backlog from hiding concrete delivery problems, while ratios escalate a
  // small board whose work is broadly affected. These are triage rules, not a claim to know scope,
  // capacity, dependencies, or stakeholder confidence.
  const atRisk = (config.overdue && (ratio(overdue) >= 0.5 || overdue >= 5))
    || (config.unassigned && active >= 2 && ratio(unassigned) >= 0.75)
    || (config.inactive && active >= 2 && ratio(inactive) >= 0.75);
  const needsAttention = (config.overdue && overdue > 0)
    || (config.unassigned && (ratio(unassigned) >= 0.25 || unassigned >= 5))
    || (config.inactive && (ratio(inactive) >= 0.25 || inactive >= 5));
  const level: BoardWorkRiskLevel = atRisk ? "atRisk" : needsAttention ? "needsAttention" : "onTrack";
  const label = level === "atRisk" ? "At risk" : level === "needsAttention" ? "Needs attention" : "On track";
  const summary = signals.length
    ? signals.map((signal) => `${signal.count} ${signal.kind}`).join(" · ")
    : "No enabled health risks";

  return { level, label, summary, signals };
}
