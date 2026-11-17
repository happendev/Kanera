import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { LOCALES } from "../locales.js";
import { valueIn } from "./_value-check.js";
import { SIGN_IN_PROVIDERS } from "./user-identity.js";
import { users } from "./user.js";

export const AUTH_PROVIDER_FLOW_INTENTS = ["login", "link"] as const;
export type AuthProviderFlowIntent = (typeof AUTH_PROVIDER_FLOW_INTENTS)[number];

/**
 * One third-party sign-in attempt, from `begin` to `complete`.
 *
 * The browser leaves Kanera for the provider and comes back through a top-level redirect, so the
 * attempt's context (PKCE verifier, invite tokens, where to land) cannot ride in the SPA's memory.
 * It is stored here rather than in Valkey so every API replica can finish an attempt another one
 * started. Invite tokens stay server-side instead of travelling through provider URLs.
 */
export const authProviderFlows = pgTable(
  "auth_provider_flow",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    provider: text("provider", { enum: SIGN_IN_PROVIDERS }).notNull(),
    intent: text("intent", { enum: AUTH_PROVIDER_FLOW_INTENTS }).notNull(),
    // OAuth `state`, hashed. Looked up on the provider callback.
    stateHash: text("state_hash").notNull(),
    // Hash of the nonce in the httpOnly `kanera_pf` cookie set by `begin`. The callback must present
    // the same browser's cookie, so a callback URL lured from another browser (login CSRF / session
    // fixation) cannot complete this attempt.
    browserNonceHash: text("browser_nonce_hash").notNull(),
    codeVerifier: text("code_verifier").notNull(),
    // Set for intent "link": the signed-in account the provider identity will be attached to.
    linkUserId: uuid("link_user_id").references(() => users.id, { onDelete: "cascade" }),
    inviteToken: text("invite_token"),
    boardInviteToken: text("board_invite_token"),
    returnUrl: text("return_url"),
    locale: text("locale", { enum: LOCALES }),
    analyticsAttribution: jsonb("analytics_attribution").$type<Record<string, unknown>>(),
    // One-time code the SPA redeems after the callback redirects back to the web app.
    handoffHash: text("handoff_hash"),
    // What the callback resolved (provider profile and next step). Server-only; never sent verbatim.
    result: jsonb("result").$type<Record<string, unknown>>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("auth_provider_flow_state_hash_uq").on(t.stateHash),
    uniqueIndex("auth_provider_flow_handoff_hash_uq").on(t.handoffHash),
    index("auth_provider_flow_expires_at_idx").on(t.expiresAt),
    check("auth_provider_flow_provider_ck", valueIn(t.provider, SIGN_IN_PROVIDERS)),
    check("auth_provider_flow_intent_ck", valueIn(t.intent, AUTH_PROVIDER_FLOW_INTENTS)),
    check("auth_provider_flow_locale_ck", valueIn(t.locale, LOCALES)),
  ],
);

export type AuthProviderFlow = typeof authProviderFlows.$inferSelect;
