import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { clients } from "./client.js";

// Organisation lifecycle moments from the marketing lifecycle-communication plan. Each is decided
// from structural signals only (counts, milestone timestamps, presence) and never from board content.
export const LIFECYCLE_EMAIL_KINDS = [
  "no_board",
  "invite_team",
  "early_success",
  "inactive",
  "active_checkin",
] as const;
export type LifecycleEmailKind = (typeof LIFECYCLE_EMAIL_KINDS)[number];

/**
 * Durable claim ledger for lifecycle emails. The sweep inserts a claim first and only queues mail
 * when the insert wins, so overlapping workers or restarts cannot send the same moment twice. It is
 * separate from email_queue because queue rows are pruned by retention cleanup, while these claims
 * must outlive delivery to keep "once per organisation" true.
 */
export const lifecycleEmailSends = pgTable(
  "lifecycle_email_send",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: LIFECYCLE_EMAIL_KINDS }).notNull(),
    // "once" for one-shot moments; repeatable moments (inactivity episodes) key on the episode.
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("lifecycle_email_send_kind_ck", valueIn(t.kind, LIFECYCLE_EMAIL_KINDS)),
    uniqueIndex("lifecycle_email_send_client_kind_key_uq").on(t.clientId, t.kind, t.dedupeKey),
    index("lifecycle_email_send_kind_created_at_idx").on(t.kind, t.createdAt),
  ],
);

export type LifecycleEmailSend = typeof lifecycleEmailSends.$inferSelect;
