import { z } from "zod";

export const AGENT_FEEDBACK_KINDS = ["error", "improvement", "other"] as const;
export type AgentFeedbackKind = (typeof AGENT_FEEDBACK_KINDS)[number];

/**
 * Feedback an agent sends to the Kanera team about Kanera itself (hosted only): a tool error it
 * could not work around, a missing capability, or confusing behaviour. It is emailed to the
 * operator's internal recipients, so it is product feedback, never a way to message workspace members.
 */
export const reportAgentFeedbackBody = z.object({
  kind: z.enum(AGENT_FEEDBACK_KINDS),
  summary: z.string().trim().min(1).max(200),
  details: z.string().trim().min(1).max(8000),
  tool: z.string().trim().min(1).max(100).optional(),
  agent: z.string().trim().min(1).max(200).optional(),
});
export type ReportAgentFeedbackBody = z.infer<typeof reportAgentFeedbackBody>;
