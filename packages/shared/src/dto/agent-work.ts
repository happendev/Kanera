import { z } from "zod";
import type { WireChecklistAssignment } from "../events/index.js";
import { ianaTimeZoneName } from "./_time-zone.js";
import type { WorkDoneEvent } from "./work-done.js";
import { workScopeSchema, type WorkCard, type WorkQueryResponse } from "./work.js";

export const AGENT_WORK_HISTORY_PRESETS = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
] as const;

export const agentWorkHistoryQueryBody = z.object({
  /** Defaults to the connected user; another user must be visible inside the selected work scope. */
  userId: z.uuid().optional(),
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

export interface AgentWorkSources {
  boards: Array<{
    id: string;
    name: string;
    url: string;
    workspaceId: string;
    workspaceName: string;
    organisationId: string;
    organisationName: string;
  }>;
  lists: Array<{ id: string; workspaceId: string; name: string }>;
  labels: Array<{ id: string; workspaceId: string; name: string; color: string | null }>;
  people: Array<{ id: string; displayName: string }>;
}

export type AgentWorkQueryResponse = Omit<WorkQueryResponse, "cards" | "checklistItems"> & {
  cards: Array<WorkCard & { url: string }>;
  checklistItems: Array<WireChecklistAssignment & { url: string }>;
  sources: AgentWorkSources;
};

type LinkedWorkDoneEvent<T extends WorkDoneEvent = WorkDoneEvent> = T extends WorkDoneEvent
  ? Omit<T, "card"> & { card: T["card"] & { url: string } }
  : never;

export interface AgentWorkHistoryResponse {
  actor: { userId: string; displayName: string };
  range: { from: string; to: string; timeZone: string };
  summary: {
    created: number;
    moved: number;
    completed: number;
    checklistItemCompleted: number;
    cardsTouched: number;
    totalEvents: number;
  };
  events: LinkedWorkDoneEvent[];
  sources: AgentWorkSources;
  nextCursor: string | null;
}
