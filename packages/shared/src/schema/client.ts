import { sql } from "drizzle-orm";
import { bigint, boolean, check, customType, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";

export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return "citext";
  },
});

export type StorageConfig =
  | { kind: "local" }
  | {
    kind: "s3";
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    publicUrlPrefix?: string;
  };

export type SmtpConfig = {
  host: string;
  port: number;
  security: "none" | "starttls" | "tls";
  username?: string;
  password?: string;
  fromEmail: string;
  fromName?: string;
};

export const CLIENT_PLANS = ["free", "paid"] as const;
export type ClientPlan = (typeof CLIENT_PLANS)[number];

export const CLIENT_BILLING_STATUSES = [
  "none",
  "trialing",
  "active",
  "past_due",
  "canceled",
] as const;
export type ClientBillingStatus = (typeof CLIENT_BILLING_STATUSES)[number];

export const CLIENT_BILLING_INTERVALS = ["monthly", "annual"] as const;
export type ClientBillingInterval = (typeof CLIENT_BILLING_INTERVALS)[number];

export const CLIENT_ROUTE_KEY_PATTERN = /^[A-F0-9]{16}$/;

export const clients = pgTable(
  "client",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    // Immutable, opaque routing namespace. Display names are deliberately not used in URLs because
    // common names such as "Private" must be reusable and renames must never break card links.
    routeKey: text("route_key")
      .notNull()
      .default(sql`upper(substr(md5(random()::text || clock_timestamp()::text || uuidv7()::text), 1, 16))`),
    name: text("name").notNull(),
    logoUrl: text("logo_url"),
    pushEnabled: boolean("push_enabled").notNull().default(false),
    // When enabled, password login cannot issue a session until the member has completed TOTP setup.
    requireMfa: boolean("require_mfa").notNull().default(false),
    // Explicitly excludes staff, demo, seed, test, and load-test organisations from product analytics.
    // This is deliberately not inferred from an email domain because analytics never receives email.
    analyticsExcluded: boolean("analytics_excluded").notNull().default(false),
    storageConfig: jsonb("storage_config").$type<StorageConfig>(),
    smtpConfig: jsonb("smtp_config").$type<SmtpConfig>(),
    plan: text("plan", { enum: CLIENT_PLANS }).notNull().default("free"),
    billingStatus: text("billing_status", { enum: CLIENT_BILLING_STATUSES }).notNull().default("none"),
    billingInterval: text("billing_interval", { enum: CLIENT_BILLING_INTERVALS }),
    storageQuotaBytes: bigint("storage_quota_bytes", { mode: "number" }),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripeSubscriptionItemId: text("stripe_subscription_item_id"),
    analyticsSubscriptionStartedAt: timestamp("analytics_subscription_started_at", { withTimezone: true }),
    analyticsSubscriptionCancelledAt: timestamp("analytics_subscription_cancelled_at", { withTimezone: true }),
    // One-shot claim marker so a trial that expires without converting emits `trial_ended` exactly once,
    // even if concurrent Stripe webhooks observe the same trialing -> canceled transition.
    analyticsTrialEndedAt: timestamp("analytics_trial_ended_at", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    // Set by a platform admin to suspend an entire org. While set, no member of the org can authenticate
    // on the tenant server (login/refresh rejected). Recoverable — cleared on reactivate.
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    // Set by a platform admin to soft-delete the org. Hides it from tenant listings and blocks all member
    // auth. Row + data are retained (storage purge is a deferred follow-up); recoverable until purged.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // Purchased seat capacity. This — NOT live headcount — is the source of truth for the Stripe
    // subscription quantity in hosted mode. Only paid subscription orgs are gated against it; trials are
    // unlimited until checkout, and free uses HOSTED_FREE_MAX_ORG_MEMBERS instead.
    seatLimit: integer("seat_limit").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("clients_plan_ck", valueIn(t.plan, CLIENT_PLANS)),
    check("clients_billing_status_ck", valueIn(t.billingStatus, CLIENT_BILLING_STATUSES)),
    check("clients_billing_interval_ck", valueIn(t.billingInterval, CLIENT_BILLING_INTERVALS)),
    check("clients_route_key_ck", sql`${t.routeKey} ~ '^[A-F0-9]{16}$'`),
    uniqueIndex("clients_route_key_key").on(t.routeKey),
  ],
);

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
