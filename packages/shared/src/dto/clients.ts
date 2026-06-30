import { z } from "zod";
import { GENERAL_NAME_MAX_LENGTH } from "./name-limits.js";

export const storageConfigSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }),
  z.object({
    kind: z.literal("s3"),
    endpoint: z.url().optional(),
    region: z.string().min(1),
    bucket: z.string().min(1),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    publicUrlPrefix: z.url().optional(),
  }),
]);
export type StorageConfigInput = z.infer<typeof storageConfigSchema>;

export const s3StorageConfigSchema = z.object({
  kind: z.literal("s3"),
  endpoint: z.url().optional(),
  region: z.string().min(1),
  bucket: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  publicUrlPrefix: z.url().optional(),
});
export type S3StorageConfigInput = z.infer<typeof s3StorageConfigSchema>;

export const smtpConfigSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  security: z.enum(["none", "starttls", "tls"]),
  username: z.string().max(255).optional(),
  password: z.string().max(1024).optional(),
  fromEmail: z.email().max(254),
  fromName: z.string().max(GENERAL_NAME_MAX_LENGTH).optional(),
});
export type SmtpConfigInput = z.infer<typeof smtpConfigSchema>;

export const updateClientBody = z.object({
  name: z.string().min(1).max(GENERAL_NAME_MAX_LENGTH).optional(),
  pushEnabled: z.boolean().optional(),
  storageConfig: storageConfigSchema.optional(),
  smtpConfig: smtpConfigSchema.nullable().optional(),
});
export type UpdateClientBody = z.infer<typeof updateClientBody>;

export const upgradePlanBody = z.object({
  interval: z.enum(["monthly", "annual"]),
});
export type UpgradePlanBody = z.infer<typeof upgradePlanBody>;

export const billingCheckoutBody = z.object({
  interval: z.enum(["monthly", "annual"]),
  // How many seats to purchase. The server floors this at the org's current used-seat count, so a
  // re-purchase after a downgrade can never buy fewer seats than are already assigned.
  seatLimit: z.number().int().positive(),
});
export type BillingCheckoutBody = z.infer<typeof billingCheckoutBody>;

// Set the org's purchased seat capacity (buy more / reduce seats). Only applies to paid subscriptions;
// trials are unlimited until checkout.
export const setSeatCapacityBody = z.object({
  seatLimit: z.number().int().positive(),
});
export type SetSeatCapacityBody = z.infer<typeof setSeatCapacityBody>;

export const billingPortalBody = z
  .object({
    intent: z.enum(["home", "invoices", "cancel_subscription", "payment_method"]).default("home"),
  })
  .optional()
  .default({ intent: "home" });
export type BillingPortalBody = z.infer<typeof billingPortalBody>;

export const testClientSmtpBody = z.object({
  smtpConfig: smtpConfigSchema.optional(),
  to: z.email().max(254),
});
export type TestClientSmtpBody = z.infer<typeof testClientSmtpBody>;

export const testClientStorageBody = z.object({
  storageConfig: s3StorageConfigSchema.optional(),
});
export type TestClientStorageBody = z.infer<typeof testClientStorageBody>;

export const publicClientResponse = z.object({
  id: z.uuid(),
  name: z.string(),
  logoUrl: z.string().nullable(),
  deploymentMode: z.enum(["self_hosted", "hosted"]),
  pushEnabled: z.boolean(),
  storageConfig: storageConfigSchema,
  storageConfigSource: z.enum(["env", "client"]),
  smtpConfig: smtpConfigSchema.nullable(),
  smtpConfigSource: z.enum(["env", "client"]).nullable(),
  proPricing: z.object({
    monthlyCents: z.number().int().nonnegative(),
    annualCents: z.number().int().nonnegative(),
  }).nullable(),
  freePlanLimits: z.object({
    maxBoards: z.number().int().positive(),
    maxOrgMembers: z.number().int().positive(),
    maxEnabledAutomations: z.number().int().positive(),
  }).nullable(),
});
export type PublicClientResponse = z.infer<typeof publicClientResponse>;

export const billingInfoResponse = z.object({
  billingStatus: z.enum(["none", "trialing", "active", "past_due", "canceled"]),
  billingInterval: z.enum(["monthly", "annual"]).nullable(),
  // Seats currently occupied (active members + paid guest seats). `seatCount` is kept as a backwards-
  // compatible alias of `usedSeats` for older clients; both carry the same value.
  seatCount: z.number().int().nonnegative(),
  usedSeats: z.number().int().nonnegative(),
  // Effective seat allowance shown to the UI: paid subscription capacity, trial used seats, or the Free cap.
  seatLimit: z.number().int().nonnegative(),
  hasStripeCustomer: z.boolean(),
  hasStripeSubscription: z.boolean(),
  currentPeriodEnd: z.string().nullable(),
  proPricing: z.object({
    monthlyCents: z.number().int().nonnegative(),
    annualCents: z.number().int().nonnegative(),
  }),
});
export type BillingInfoResponse = z.infer<typeof billingInfoResponse>;

// Response to POST /billing/seats. Same shape as billing info, plus an optional paymentConfirmation: when
// present, the seat increase created a proration invoice that needs the customer to confirm payment in-app
// via Stripe.js (3DS/SCA or a redirect wallet). seatLimit still reflects the OLD capacity until the client
// confirms and calls /billing/seats/confirm.
export const seatChangeResponse = billingInfoResponse.extend({
  paymentConfirmation: z
    .object({ clientSecret: z.string().min(1), publishableKey: z.string().min(1) })
    .nullish(),
});
export type SeatChangeResponse = z.infer<typeof seatChangeResponse>;

export const updateOrgUserBody = z.object({
  role: z.enum(["owner", "admin", "member"]),
});
export type UpdateOrgUserBody = z.infer<typeof updateOrgUserBody>;

// Plan entitlements surfaced to the client so the UI can gate create affordances. The server is the
// source of truth and still enforces every limit; this payload only drives UX. `null` maxima mean
// unlimited (trial/paid/self-hosted). `limited` is true only for hosted free-tier orgs.
export type Entitlements = {
  tier: "free" | "trial" | "paid";
  // ISO timestamp of when the current trial ends; null unless the org is on a trial. Drives the
  // trial countdown shown on the home page and in organisation settings.
  trialEndsAt: string | null;
  limited: boolean;
  maxBoards: number | null;
  maxOrgMembers: number | null;
  maxEnabledAutomations: number | null;
  guestsAllowed: boolean;
  apiAllowed: boolean;
  webhooksAllowed: boolean;
};
