import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { boards } from "./board.js";
import { cards } from "./card.js";
import { oauthGrants } from "./oauth.js";
import { users } from "./user.js";
import { workspaces } from "./workspace.js";

/**
 * Lifecycle of one agent run on a card. `running` and `blocked` are the two live states: a card
 * with a live run shows an "agent working" chip. `blocked` means the agent is waiting on a person
 * (a question, an approval). Terminal states never revert. `stalled` is set by the worker when a
 * live run stops sending heartbeats, so an agent that crashed cannot leave a card "working"
 * forever; the agent may still finish a stalled run with a terminal status.
 */
export const AGENT_RUN_STATUSES = ["running", "blocked", "succeeded", "failed", "cancelled", "stalled"] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];
export const AGENT_RUN_LIVE_STATUSES = ["running", "blocked"] as const satisfies readonly AgentRunStatus[];
export const AGENT_RUN_TERMINAL_STATUSES = ["succeeded", "failed", "cancelled"] as const satisfies readonly AgentRunStatus[];

export const agentRuns = pgTable(
  "agent_run",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    // The person the agent acts for. Authorization for every run mutation is evaluated against this
    // user's live board role, exactly like any other public-API write.
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    // Null for runs started by an API key rather than an OAuth agent grant; agentName is always set
    // so the UI never has to resolve a credential to label the run.
    agentGrantId: uuid("agent_grant_id")
      .references(() => oauthGrants.id, { onDelete: "set null" }),
    agentName: text("agent_name").notNull(),
    status: text("status", { enum: AGENT_RUN_STATUSES }).notNull().default("running"),
    title: text("title").notNull(),
    // Free-text progress or outcome note the agent maintains; shown under the title in card detail.
    summary: text("summary"),
    // Where a person can watch or resume the run (a PR, a session log, a chat thread).
    externalUrl: text("external_url"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("agent_runs_status_ck", valueIn(t.status, AGENT_RUN_STATUSES)),
    index("agent_runs_card_id_started_at_idx").on(t.cardId, t.startedAt),
    index("agent_runs_board_id_started_at_idx").on(t.boardId, t.startedAt),
    // The stall sweep only ever scans live runs, so keep that index tiny.
    index("agent_runs_live_heartbeat_idx").on(t.heartbeatAt).where(sql`${t.status} in ('running', 'blocked')`),
  ],
);

export type AgentRun = typeof agentRuns.$inferSelect;
