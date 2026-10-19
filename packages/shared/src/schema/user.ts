import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { ACCENTS, THEMES } from "../appearance.js";
import { LOCALES } from "../locales.js";
import { citext } from "./_citext.js";
import { valueIn } from "./_value-check.js";
import { clients } from "./client.js";

export const users = pgTable(
  "user",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    // The organisation this account created in remains the storage/media anchor even when the
    // user is acting in another organisation.
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    // The default organisation for fresh sessions. Access still requires an active client_member;
    // a nullable FK lets removal repoint this safely in the later read-new rollout.
    activeClientId: uuid("active_client_id").references(() => clients.id, { onDelete: "set null" }),
    email: citext("email").notNull(),
    // Timestamp the email was proven (code verified at signup or on an email change).
    // Null only for legacy rows created before verification existed; the signup flow
    // always sets it now since accounts are created after the code is verified.
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    timezone: text("timezone").notNull().default("UTC"),
    // On-screen only: exports, the "Copy key" actions and /o/{org}/c/{KEY} routes always keep the key.
    // Account-scoped rather than per-device, so the preference follows the person across browsers.
    showCardKeys: boolean("show_card_keys").notNull().default(true),
    // The scratchpad is optional personal chrome. Keep this account-scoped so hiding it follows the
    // person across devices, while the default preserves the existing experience for every user.
    showScratchpad: boolean("show_scratchpad").notNull().default(true),
    // Appearance is account-scoped so it follows the person across devices; the browser keeps a copy
    // in localStorage only so index.html can paint the right theme before Angular boots. Null means
    // "never chosen on this account": the device cache or the OS preference stands, and nothing is
    // written until the user actually picks one — so shipping this does not restyle existing users,
    // and signing in on a fresh machine does not overwrite what was chosen elsewhere.
    theme: text("theme", { enum: THEMES }),
    accent: text("accent", { enum: ACCENTS }),
    // Interface language, account-scoped so it follows the person across devices and so server-side
    // mail and push (which have no browser to ask) reach them in it. Signup records the language the
    // browser was showing; null is a legacy account that never chose, which the web app resolves from
    // the browser and mail renders in SOURCE_LOCALE.
    locale: text("locale", { enum: LOCALES }),
    // The home "Getting started" checklist. Account-scoped like the preferences above, so closing
    // it on one device closes it everywhere. Hidden moves it off home (the account menu still has
    // it) and can be undone; dismissed removes it for good.
    gettingStartedHiddenAt: timestamp("getting_started_hidden_at", { withTimezone: true }),
    gettingStartedDismissedAt: timestamp("getting_started_dismissed_at", { withTimezone: true }),
    // First use of the steps that leave no durable trace of their own (opening the palette, a
    // filter, Work done, quick edit), as step key -> ISO timestamp. Every other step is derived from
    // the rows the step itself creates. A map rather than a column each: these come and go with the
    // checklist's copy, and none is ever queried across users.
    gettingStartedUsed: jsonb("getting_started_used").$type<Partial<Record<string, string>>>().notNull().default({}),
    lastOnlineAt: timestamp("last_online_at", { withTimezone: true }),
    // Set by a platform admin to soft-delete the user. Hides them from tenant listings and blocks auth;
    // the row is retained so historical author/audit references stay valid. Recoverable until purged.
    // Distinct from `removedAt` (org-admin removal) and `suspendedAt` (plan/admin suspension).
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // Set when deletion of the user's final organisation leaves the identity intentionally intact.
    // A later password login bootstraps a clean organisation, matching first-signup behaviour.
    needsOrganisationOnLoginAt: timestamp("needs_organisation_on_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_email_uq").on(t.email),
    index("users_client_id_created_at_idx").on(t.clientId, t.createdAt),
    // NULL passes a CHECK, which is what keeps "not chosen" representable alongside the closed set.
    check("users_theme_ck", valueIn(t.theme, THEMES)),
    check("users_accent_ck", valueIn(t.accent, ACCENTS)),
    check("users_locale_ck", valueIn(t.locale, LOCALES)),
  ],
);

export type User = typeof users.$inferSelect;
