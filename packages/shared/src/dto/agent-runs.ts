import { z } from "zod";
import { AGENT_RUN_STATUSES, AGENT_RUN_TERMINAL_STATUSES, type AgentRun } from "../schema/agent-run.js";

const runTitle = z.string().trim().min(1).max(200);
const runSummary = z.string().trim().max(4000);
const runExternalUrl = z.url().max(2000);

/**
 * Start a run on a card. Status begins as "running"; the agent later reports progress with the
 * update body and closes the run with a terminal status. Runs are per-agent-per-card work sessions,
 * not tasks: a long job may heartbeat many times and post several summaries before it ends.
 */
export const startAgentRunBody = z.object({
  title: runTitle,
  summary: runSummary.optional(),
  externalUrl: runExternalUrl.nullable().optional(),
});
export type StartAgentRunBody = z.infer<typeof startAgentRunBody>;

// Any update counts as a heartbeat, so a bare `{}` body is a legitimate "still alive" ping. A
// terminal status ends the run; stalled runs may still be closed, but ended runs are immutable.
export const updateAgentRunBody = z.object({
  status: z.enum(AGENT_RUN_STATUSES).optional(),
  title: runTitle.optional(),
  summary: runSummary.nullable().optional(),
  externalUrl: runExternalUrl.nullable().optional(),
});
export type UpdateAgentRunBody = z.infer<typeof updateAgentRunBody>;

export const listAgentRunsQuery = z.object({
  // Default to live runs only; card detail asks for everything.
  includeEnded: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListAgentRunsQuery = z.infer<typeof listAgentRunsQuery>;

export function isTerminalAgentRunStatus(status: AgentRun["status"]): boolean {
  return (AGENT_RUN_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export type AgentRunRow = AgentRun;
