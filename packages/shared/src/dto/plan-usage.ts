import { z } from "zod";

/**
 * Hosted plan usage meters (Settings → Organisation → Account Plan). Each meter reports the same
 * count and cap the tier-limit enforcement uses, so a meter at its limit means the next create
 * really is refused. Self-hosted has no plans: `tier` is null and `meters` is empty.
 *
 * - `boards`: live (unarchived) boards across the whole organisation, standalone boards included.
 * - `members`: active organisation members (Free caps members; pending invites, suspended and
 *   removed members do not count).
 * - `seats`: active members plus paid guest seats (trial and Pro draw from the seat pool).
 * - `activeAutomations`: enabled automations across the organisation.
 * - `automationExecutions`: executions claimed this UTC calendar month; `resetsAt` is when the
 *   window rolls over. Only metered while the plan caps it, so `used` is null otherwise.
 */
export const PLAN_USAGE_METER_KEYS = ["boards", "members", "seats", "activeAutomations", "automationExecutions"] as const;
export type PlanUsageMeterKey = (typeof PLAN_USAGE_METER_KEYS)[number];

export const planUsageMeter = z.object({
  key: z.enum(PLAN_USAGE_METER_KEYS),
  used: z.number().int().nonnegative().nullable(),
  // null means unlimited on this plan; render usage without a bar.
  limit: z.number().int().nonnegative().nullable(),
  resetsAt: z.string().nullable(),
});
export type PlanUsageMeter = z.infer<typeof planUsageMeter>;

export const planUsageResponse = z.object({
  tier: z.enum(["free", "trial", "paid"]).nullable(),
  meters: z.array(planUsageMeter),
});
export type PlanUsageResponse = z.infer<typeof planUsageResponse>;
