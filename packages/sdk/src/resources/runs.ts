import type { AgentRun, AgentRunStatus, Uuid } from "../types.js";
import type { CallOptions, ResourceContext } from "./base.js";

export interface StartRunInput {
  /** Short description of the work, e.g. "Implementing OAuth refresh". */
  title: string;
  /** Optional longer progress note shown in card detail. */
  summary?: string;
  /** Where a person can watch or resume the work: a pull request, session log, or chat thread. */
  externalUrl?: string | null;
}

export interface UpdateRunInput {
  status?: AgentRunStatus;
  title?: string;
  /** Null clears the note. */
  summary?: string | null;
  externalUrl?: string | null;
}

/**
 * Agent runs: tell Kanera that an agent is working on a card so people see it live.
 *
 * ```ts
 * const run = await kanera.runs.start("MKT-42", { title: "Drafting launch copy" });
 * // ... every few minutes while working:
 * await kanera.runs.heartbeat(run.id);
 * await kanera.runs.finish(run.id, "succeeded", { summary: "Draft posted as a comment." });
 * ```
 *
 * Any update is a heartbeat. A live run with no heartbeat for 15 minutes is marked `stalled`.
 */
export class Runs {
  constructor(private readonly ctx: ResourceContext) {}

  async list(
    card: string,
    options: { includeEnded?: boolean; limit?: number } & CallOptions = {},
  ): Promise<{ runs: AgentRun[] }> {
    const { includeEnded, limit, ...call } = options;
    return this.ctx.http.get(`/api/v1/cards/${await this.ctx.resolveCard(card)}/agent-runs`, { ...call, query: { includeEnded, limit } });
  }

  /** Not idempotent; pass `idempotencyKey` if you may retry after an ambiguous failure. */
  async start(card: string, input: StartRunInput, options: CallOptions = {}): Promise<AgentRun> {
    return this.ctx.http.post<AgentRun>(`/api/v1/cards/${await this.ctx.resolveCard(card)}/agent-runs`, input, options);
  }

  get(runId: Uuid, options: CallOptions = {}): Promise<AgentRun> {
    return this.ctx.http.get<AgentRun>(`/api/v1/agent-runs/${runId}`, options);
  }

  update(runId: Uuid, input: UpdateRunInput, options: CallOptions = {}): Promise<AgentRun> {
    return this.ctx.http.patch<AgentRun>(`/api/v1/agent-runs/${runId}`, input, options);
  }

  /** Keep a long run alive without changing anything. */
  heartbeat(runId: Uuid, options: CallOptions = {}): Promise<AgentRun> {
    return this.update(runId, {}, options);
  }

  finish(
    runId: Uuid,
    status: Extract<AgentRunStatus, "succeeded" | "failed" | "cancelled">,
    input: Omit<UpdateRunInput, "status"> = {},
    options: CallOptions = {},
  ): Promise<AgentRun> {
    return this.update(runId, { ...input, status }, options);
  }
}
