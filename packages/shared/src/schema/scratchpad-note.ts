import { sql } from "drizzle-orm";
import { index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { clients } from "./client.js";
import { users } from "./user.js";

/**
 * One person's private scratchpad within one organisation: a flat, ordered set of named rich-text
 * pages that lives beside the app rather than inside any workspace. Switching organisations switches
 * scratchpads. This is the "tabbed notepad next to Kanera" surface — quick jottings, pasted
 * screenshots, personal todo lists — and its defining property is that nobody else can ever see it.
 *
 * Deliberately NOT an extension of `note`. `note.workspace_id` is non-null, so every note belongs to
 * a workspace and inherits that workspace's audience; a scratchpad page belongs to a *person within
 * an organisation* and crosses that organisation's workspaces only. `note` also carries a tree, a
 * single-writer edit lock, a search vector, backlinks, and a public-API surface — all of which are
 * wrong here: the scratchpad is flat, lock-free (last-write-wins autosave, because one person typing
 * on their own page has no conflict worth a 409), and internal-only.
 *
 * Access is the pair `user_id = req.auth.sub AND client_id = req.auth.cid`: the first half keeps the
 * pages private, while the second selects the active organisation's scratchpad and makes attachment
 * storage, signing, quota accounting, and organisation deletion use that same tenant boundary. An org
 * role, including owner, never grants access to another person's rows.
 */
export const scratchpadNotes = pgTable(
  "scratchpad_note",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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
    // Leads with both access columns, then position, so listing one organisation's scratchpad is one
    // index range scan returning pre-ordered rows with no sort node.
    index("scratchpad_notes_user_client_position_idx").on(t.userId, t.clientId, t.position),
    // Storage-quota sums and organisation deletion scan by client_id.
    index("scratchpad_notes_client_id_idx").on(t.clientId),
  ],
);

/** A scratchpad is a handful of working pages, not a document store. 50 keeps the tab strip
 * navigable, keeps the list read (which returns full content for every page) bounded, and pushes
 * anyone who wants a real hierarchy towards Notes, which is built for it. */
export const MAX_SCRATCHPAD_NOTES = 50;

export type ScratchpadNote = typeof scratchpadNotes.$inferSelect;
