import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { WorkViewDefinition } from "../dto/work.js";
import { valueIn } from "./_value-check.js";
import { clients } from "./client.js";
import { users } from "./user.js";

export const WORK_VIEW_LENSES = ["my", "team", "portfolio"] as const;
export type WorkViewLens = (typeof WORK_VIEW_LENSES)[number];

export const WORK_VIEW_VISIBILITIES = ["private", "organisation"] as const;
export type WorkViewVisibility = (typeof WORK_VIEW_VISIBILITIES)[number];

export const workViews = pgTable(
  "work_view",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    lens: text("lens", { enum: WORK_VIEW_LENSES }).notNull(),
    visibility: text("visibility", { enum: WORK_VIEW_VISIBILITIES }).notNull().default("private"),
    definitionVersion: integer("definition_version").notNull().default(1),
    definition: jsonb("definition").notNull().$type<WorkViewDefinition>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("work_views_lens_ck", valueIn(t.lens, WORK_VIEW_LENSES)),
    check("work_views_visibility_ck", valueIn(t.visibility, WORK_VIEW_VISIBILITIES)),
    check("work_views_definition_version_ck", sql`${t.definitionVersion} > 0`),
    index("work_views_owner_updated_idx").on(t.ownerId, t.updatedAt),
    index("work_views_client_visibility_idx").on(t.clientId, t.visibility, t.updatedAt),
  ],
);

export const workViewShares = pgTable(
  "work_view_share",
  {
    viewId: uuid("view_id")
      .notNull()
      .references(() => workViews.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.viewId, t.userId] }),
    index("work_view_shares_user_idx").on(t.userId, t.createdAt),
  ],
);

export type WorkView = typeof workViews.$inferSelect;
export type WorkViewShare = typeof workViewShares.$inferSelect;
