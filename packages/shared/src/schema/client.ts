import { sql } from "drizzle-orm";
import { bigint, boolean, customType, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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

export const clientPlan = pgEnum("client_plan", ["free", "paid"]);
export type ClientPlan = (typeof clientPlan.enumValues)[number];

export const clientBillingStatus = pgEnum("client_billing_status", [
  "none",
  "trialing",
  "active",
  "past_due",
  "canceled",
]);
export type ClientBillingStatus = (typeof clientBillingStatus.enumValues)[number];

export const clientBillingInterval = pgEnum("client_billing_interval", ["monthly", "annual"]);
export type ClientBillingInterval = (typeof clientBillingInterval.enumValues)[number];

export const clients = pgTable("client", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
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
  plan: clientPlan("plan").notNull().default("free"),
  billingStatus: clientBillingStatus("billing_status").notNull().default("none"),
  billingInterval: clientBillingInterval("billing_interval"),
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
});

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
