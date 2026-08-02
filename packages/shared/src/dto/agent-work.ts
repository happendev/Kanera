import { z } from "zod";
import { ianaTimeZoneName } from "./_time-zone.js";
import { workScopeSchema } from "./work.js";

export const AGENT_WORK_HISTORY_PRESETS = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
] as const;

export const agentWorkHistoryQueryBody = z.object({
  preset: z.enum(AGENT_WORK_HISTORY_PRESETS).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  timeZone: ianaTimeZoneName.optional(),
  scope: workScopeSchema.optional(),
  q: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().min(1).max(2000).optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).superRefine((value, ctx) => {
  const exactRange = value.from !== undefined || value.to !== undefined;
  if (exactRange && (!value.from || !value.to)) {
    ctx.addIssue({ code: "custom", path: [value.from ? "to" : "from"], message: "from and to must be provided together" });
  }
  if (value.preset && exactRange) {
    ctx.addIssue({ code: "custom", path: ["preset"], message: "preset cannot be combined with from and to" });
  }
});
export type AgentWorkHistoryQuery = z.infer<typeof agentWorkHistoryQueryBody>;

export const agentCurrentWorkQueryBody = z.object({
  scope: workScopeSchema.optional(),
  q: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().min(1).max(500_000).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type AgentCurrentWorkQuery = z.infer<typeof agentCurrentWorkQueryBody>;
