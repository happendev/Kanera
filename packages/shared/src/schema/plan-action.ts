import { sql } from "drizzle-orm";
import { index, jsonb, pgEnum, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { clients } from "./client.js";

// Records each resource that a downgrade-to-free reconciliation disabled, so a later upgrade to
// trial/paid can restore *exactly* what the downgrade touched — and nothing the user disabled
// themselves. Without this audit, an upgrade could not tell a downgrade-archived board from one the
// user archived on purpose. Rows are deleted as they are restored (see restoreFromPlanActions).
export const planActionKind = pgEnum("plan_action_kind", [
  "automation_disabled",
  "webhook_disabled",
  "api_key_revoked",
  "board_archived",
  "workspace_archived",
  "user_suspended",
  "guest_member_removed",
  "guest_invitation_revoked",
  "guest_seat_removed",
]);
export type PlanActionKind = (typeof planActionKind.enumValues)[number];

// Per-kind shape of `payload`. Carries the minimum needed to reverse the action. Guest memberships
// are hard-deleted on downgrade, so their full identity (board + user + role) is stored for re-insert.
export type PlanActionPayload =
  | { automationId: string }
  | { webhookId: string }
  | { apiKeyId: string }
  | { boardId: string }
  | { workspaceId: string }
  | { userId: string }
  | { boardId: string; userId: string; role: string }
  | { invitationId: string };

export const planActions = pgTable(
  "plan_action",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    kind: planActionKind("kind").notNull(),
    payload: jsonb("payload").notNull().$type<PlanActionPayload>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("plan_actions_client_id_idx").on(t.clientId),
  ],
);

export type PlanAction = typeof planActions.$inferSelect;
export type NewPlanAction = typeof planActions.$inferInsert;
