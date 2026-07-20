import { pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspace.js";

// Server-internal idempotency state is isolated from the workspace entity so it can never leak through
// generic workspace API/realtime serialization.
export const workspaceAnalyticsMilestones = pgTable("workspace_analytics_milestone", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  // Legacy fields retained for compatibility with deployments that briefly emitted the superseded
  // activation/qualification taxonomy before the approved July 2026 event contract was applied.
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  qualifiedAt: timestamp("qualified_at", { withTimezone: true }),
  meaningfulWorkCreatedAt: timestamp("meaningful_work_created_at", { withTimezone: true }),
  collaborationStartedAt: timestamp("collaboration_started_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WorkspaceAnalyticsMilestone = typeof workspaceAnalyticsMilestones.$inferSelect;
