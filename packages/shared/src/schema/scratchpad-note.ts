import { sql } from "drizzle-orm";
import { index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { clients } from "./client.js";
import { users } from "./user.js";

/**
 * One person's private scratchpad: a flat, ordered set of named rich-text pages that lives beside the
 * app rather than inside any workspace. This is the "tabbed notepad next to Kanera" surface — quick
 * jottings, pasted screenshots, personal todo lists — and its defining property is that nobody else
 * can ever see it.
 *
 * Deliberately NOT an extension of `note`. `note.workspace_id` is non-null, so every note belongs to
 * a workspace and inherits that workspace's audience; a scratchpad page belongs to a *person* and
 * crosses every workspace they can see. `note` also carries a tree, a single-writer edit lock, a
 * search vector, backlinks, and a public-API surface — all of which are wrong here: the scratchpad is
 * flat, lock-free (last-write-wins autosave, because one person typing on their own page has no
 * conflict worth a 409), and internal-only.
 *
 * `client_id` is deliberately NOT an access column. Access is exactly `user_id = req.auth.sub` and
 * nothing else — no org role, not even an org owner, grants a read. `client_id` exists solely so the
 * infrastructure that is inherently org-shaped can work: attachment storage buckets and signing keys
 * are resolved per client, storage quota is summed per client, and organisation deletion needs to
 * find these files. It is denormalized from the owning user at creation, and a route must never
 * widen a read from `user_id` to `client_id`.
 */
export const scratchpadNotes = pgTable(
  "scratchpad_note",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Storage/quota/signing tenancy only — never an access column. See the table comment above.
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    // markdown body (signed media URLs stripped on write, re-signed on read — same as `note.content`)
    content: text("content").notNull().default(""),
    position: numeric("position", { precision: 20, scale: 10 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Leads with user_id then position so the only list read is one index range scan returning
    // pre-ordered rows with no sort node.
    index("scratchpad_notes_user_position_idx").on(t.userId, t.position),
    // Storage-quota sums and organisation deletion scan by client_id.
    index("scratchpad_notes_client_id_idx").on(t.clientId),
  ],
);

/** A scratchpad is a handful of working pages, not a document store. 50 keeps the tab strip
 * navigable, keeps the list read (which returns full content for every page) bounded, and pushes
 * anyone who wants a real hierarchy towards Notes, which is built for it. */
export const MAX_SCRATCHPAD_NOTES = 50;

export type ScratchpadNote = typeof scratchpadNotes.$inferSelect;
export type NewScratchpadNote = typeof scratchpadNotes.$inferInsert;
