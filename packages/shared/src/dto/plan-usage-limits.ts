// Zod-free so the web app can import these without pulling the DTO schemas into its bundle.

/**
 * Hosted plan meters turn to a warning at this share of a limit. Kept in step with
 * STORAGE_WARNING_PERCENT so every usage meter on the plan page warns at the same point.
 */
export const PLAN_USAGE_WARNING_PERCENT = 80;

/**
 * - `unlimited`: the plan has no cap for this meter (trial, Pro, or a meter Pro does not count).
 * - `ok` / `warning`: below / at or above PLAN_USAGE_WARNING_PERCENT of the cap.
 * - `limit`: the cap is reached. Count limits block the next create; the monthly execution cap
 *   skips further automation runs until the period resets.
 */
export type PlanUsageLevel = "unlimited" | "ok" | "warning" | "limit";

/** Share of the limit used, clamped to 0..100; null when the meter has no limit. */
export function planUsagePercent(used: number | null, limit: number | null): number | null {
  if (limit === null) return null;
  // A zero cap is already exhausted; this also keeps the division below away from zero.
  if (limit <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round(((used ?? 0) / limit) * 100)));
}

export function planUsageLevel(used: number | null, limit: number | null): PlanUsageLevel {
  if (limit === null) return "unlimited";
  // Compare raw counts for "at limit": rounding 99.6% up to 100 must not claim the cap is reached.
  if ((used ?? 0) >= limit) return "limit";
  const percent = planUsagePercent(used, limit) ?? 0;
  return percent >= PLAN_USAGE_WARNING_PERCENT ? "warning" : "ok";
}
