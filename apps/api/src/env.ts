import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import "./load-env.js";

const HOSTED_MODE_TOKEN_SHA256 = "c436db886c499ec84d0d0fe42fc9ba99a2f7c7d7456e45f216e998a8c10d2544";
const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);
const commaSeparatedEmails = (value: unknown) => {
  if (typeof value !== "string") return value;
  return value
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
};

function sha256Hex(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function matchesSha256(value: string, expectedSha256: string) {
  const actual = Buffer.from(sha256Hex(value), "hex");
  const expected = Buffer.from(expectedSha256, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isLocalUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

type EnvironmentSchemaOptions = {
  hostedModeTokenSha256?: string;
};

export function createEnvironmentSchema(options: EnvironmentSchemaOptions = {}) {
  const hostedModeTokenSha256 = options.hostedModeTokenSha256 ?? HOSTED_MODE_TOKEN_SHA256;
  return z
  .object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  KANERA_ENVIRONMENT: z.enum(["development", "test", "staging", "production"]).optional(),
  API_PORT: z.coerce.number().int().positive().default(3000),
  WORKER_PORT: z.coerce.number().int().positive().default(3003),
  API_TRUST_PROXY: z
    .union([z.string(), z.boolean()])
    .transform((v) => v === true || v === "true")
    .default(false),
  PUBLIC_API_PORT: z.coerce.number().int().positive().default(3001),
  PUBLIC_API_OAUTH_ISSUER: z.url().default("http://localhost:3001"),
  MCP_PUBLIC_URL: z.url().default("http://localhost:3002/mcp"),
  PUBLIC_API_RATE_LIMIT_ENABLED: z
    .union([z.string(), z.boolean()])
    .transform((v) => v === true || v === "true")
    .default(true),
  PUBLIC_API_IP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  PUBLIC_API_FAILED_KEY_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  PUBLIC_API_KEY_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(400),
  PUBLIC_API_UPLOAD_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),
  PUBLIC_API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  PUBLIC_API_TRUST_PROXY: z
    .union([z.string(), z.boolean()])
    .transform((v) => v === true || v === "true")
    .default(false),
  KANERA_DEPLOYMENT_MODE: z.enum(["self_hosted", "hosted"]).default("self_hosted"),
  KANERA_HOSTED_MODE_TOKEN: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  ANALYTICS_ENABLED: z
    .union([z.string(), z.boolean()])
    .transform((v) => v === true || v === "true")
    .default(false),
  ANALYTICS_PROVIDER: z.preprocess(emptyToUndefined, z.literal("posthog").optional()),
  // PostHog capture uses this public project token for both browser and server-side events.
  POSTHOG_PROJECT_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  POSTHOG_API_HOST: z.preprocess(emptyToUndefined, z.url().optional()),
  ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(104_857_600),
  HOSTED_FREE_ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(5_242_880),
  HOSTED_FREE_STORAGE_QUOTA_BYTES: z.coerce.number().int().nonnegative().default(524_288_000),
  HOSTED_PAID_STORAGE_QUOTA_BYTES: z.coerce.number().int().nonnegative().default(214_748_364_800),
  HOSTED_PRO_PRICE_MONTHLY_CENTS: z.coerce.number().int().nonnegative().default(500),
  HOSTED_PRO_PRICE_ANNUAL_CENTS: z.coerce.number().int().nonnegative().default(300),
  STRIPE_SECRET_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  // Non-secret. Sent to the browser so Stripe.js can confirm seat-increase payments (3DS/SCA) in-app.
  STRIPE_PUBLISHABLE_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  STRIPE_WEBHOOK_SECRET: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  STRIPE_PRICE_ID_PRO_MONTHLY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  STRIPE_PRICE_ID_PRO_ANNUAL: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  // Free-tier product caps in hosted mode. Only apply when the org's billing status is not paid-tier
  // (see isPaidTier). Trial, active, dunning, and all self-hosted orgs are unlimited.
  HOSTED_FREE_MAX_BOARDS: z.coerce.number().int().positive().default(3),
  HOSTED_FREE_MAX_ORG_MEMBERS: z.coerce.number().int().positive().default(4),
  HOSTED_FREE_MAX_ENABLED_AUTOMATIONS: z.coerce.number().int().positive().default(1),
  HOSTED_FREE_MAX_GUEST_BOARDS: z.coerce.number().int().positive().default(2),
  // Length of the automatic trial granted to a new org on signup in hosted mode. When it lapses the
  // trial-expiry sweep downgrades the org to free (no payment required).
  HOSTED_TRIAL_DAYS: z.coerce.number().int().positive().default(30),
  // Per-IP brute-force throttle for unauthenticated /auth/* endpoints (login, signup,
  // forgot/reset password). Defaults are intentionally tight; keep this on in production.
  AUTH_RATE_LIMIT_ENABLED: z
    .union([z.string(), z.boolean()])
    .transform((v) => v === true || v === "true")
    .default(true),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  // Admin login has a separate, stricter per-IP policy because cycling through account emails must
  // not evade the per-account lockout.
  ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(5 * 60_000),
  ADMIN_LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  // Controls public self-signup/new org creation. Existing organisation invite
  // acceptance is still allowed so admins can add users to an existing tenant.
  SIGNUPS_ENABLED: z
    .union([z.string(), z.boolean()])
    .transform((v) => v === true || v === "true")
    .default(true),
  // Gates mailbox-proof flows for signup and email changes. Defaults off so self-hosted
  // deployments are usable before SMTP is configured; hosted deployments opt in explicitly.
  EMAIL_VERIFICATION_ENABLED: z
    .union([z.string(), z.boolean()])
    .transform((v) => v === true || v === "true")
    .default(false),
  // Enables Cloudflare Turnstile on hosted public signup flows when both values are present.
  // The site key is public and returned from /auth/config; the secret only stays server-side.
  CLOUDFLARE_TURNSTILE_SITE_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  CLOUDFLARE_TURNSTILE_SECRET_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  WEB_ORIGIN: z.url().default("http://localhost:4200"),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  DATABASE_SSL: z
    .union([z.string(), z.boolean()])
    .transform((v) => v === true || v === "true")
    .default(false),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),
  WORKER_PG_POOL_MAX: z.coerce.number().int().positive().default(5),
  PG_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),
  PG_CONNECTION_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(5_000),
  PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),
  SLOW_QUERY_LOG_MS: z.coerce.number().int().nonnegative().default(250),
  SLOW_REQUEST_LOG_MS: z.coerce.number().int().nonnegative().default(2_500),
  // Exposes a Prometheus /metrics endpoint (HTTP latency, DB query latency, pg pool saturation, Node
  // runtime metrics) on each service. Safe to leave on; the endpoint is internal-only on the app api.
  METRICS_ENABLED: z
    .union([z.string(), z.boolean()])
    .transform((v) => v === true || v === "true")
    .default(true),
  // Bearer token required to scrape GET /metrics. The endpoint fails closed when this is absent so
  // an application listener becoming publicly reachable cannot expose operational data. Min 16 chars.
  METRICS_TOKEN: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
  REALTIME_EMIT_METRICS_ENABLED: z
    .union([z.string(), z.boolean()])
    .transform((v) => v === true || v === "true")
    .default(false),
  REALTIME_EMIT_METRICS_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.01),
  REALTIME_EMIT_METRICS_MIN_BYTES: z.coerce.number().int().nonnegative().default(0),
  REALTIME_WEBSOCKET_COMPRESSION_ENABLED: z
    .union([z.string(), z.boolean()])
    .transform((v) => v === true || v === "true")
    .default(true),
  REALTIME_WEBSOCKET_COMPRESSION_THRESHOLD_BYTES: z.coerce.number().int().nonnegative().default(1024),
  REALTIME_OUTBOX_POLL_MS: z.coerce.number().int().positive().default(1_000),
  REALTIME_OUTBOX_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  // Backstop for outbox rows that never dispatch (unhealthy realtime/webhook delivery). Past this
  // window a row is deleted regardless of dispatch status: a realtime event this old is stale (clients
  // have long since reconnected and re-fetched current state) and the webhook side is past any retry
  // horizon. Kept separate from the processed-row window so the "give up on stuck rows" horizon can be
  // tuned independently; defaults equal.
  OUTBOX_STUCK_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  // Retention windows for tables that would otherwise grow unbounded for active tenants. All are
  // enforced by the daily retention-cleanup sweep; see apps/api/src/lib/retention-cleanup.ts.
  ACTIVITY_EVENT_RETENTION_DAYS: z.coerce.number().int().positive().default(730),
  ADMIN_AUDIT_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(1095),
  // Read notifications are pruned aggressively; the max window is a floor that also clears never-read
  // stragglers so the table can't grow forever for a user who never opens their inbox.
  NOTIFICATION_READ_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  NOTIFICATION_MAX_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
  // Grace after a token/invite becomes terminal (expired/used/consumed/revoked/accepted) before it is
  // purged. Keeps just-expired rows briefly for debugging and avoids racing rows near their expiry.
  AUTH_TOKEN_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  OPS_ALERTS_ENABLED: z
    .union([z.string(), z.boolean()])
    .transform((v) => v === true || v === "true")
    .default(true),
  OPS_ALERT_THROTTLE_MS: z.coerce.number().int().nonnegative().default(300_000),
  // Operational alert destination: a single Slack-compatible incoming webhook (Slack, Zulip's
  // slack_incoming integration, Mattermost, Discord, ...). The same webhook also drives Grafana's
  // alerts when the monitoring stack is enabled (docker-compose.yml maps it to GF_ALERT_WEBHOOK_URL).
  ALERT_WEBHOOK_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  USER_DISPLAY_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(60_000),
  JWT_SECRET: z.string().min(16),
  // Dedicated AES/HMAC key for TOTP secrets, recovery-code hashes, and short-lived MFA challenges.
  // Keep stable across every API process; changing it invalidates every enrolled authenticator.
  MFA_ENCRYPTION_KEY: z.string().min(32),
  MEDIA_SIGNING_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default("5m"),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(10),
  // Management portal. It runs as an optional separate process in either deployment mode. Auth is fully
  // separate from the tenant app: its own JWT secret, cookie, and refresh table. ADMIN_JWT_SECRET
  // MUST differ from JWT_SECRET (asserted below) so a tenant token can never verify on the admin API.
  ADMIN_API_PORT: z.coerce.number().int().positive().default(3002),
  ADMIN_JWT_SECRET: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
  ADMIN_JWT_ACCESS_TTL: z.string().default("15m"),
  ADMIN_JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),
  ADMIN_WEB_ORIGIN: z.preprocess(emptyToUndefined, z.url().default("http://localhost:4300")),
  // Bootstraps the first superadmin on startup when no admins exist. Optional; a warning is logged when
  // absent so a fresh deploy is not silently left with no way in.
  ADMIN_EMAIL: z.preprocess(emptyToUndefined, z.email().optional()),
  ADMIN_PASSWORD: z.preprocess(emptyToUndefined, z.string().min(8).optional()),
  ADMIN_TRUST_PROXY: z
    .union([z.string(), z.boolean()])
    .transform((v) => v === true || v === "true")
    .default(false),
  // Optional admin-only override. Use when the tenant app and admin portal live on sibling hostnames,
  // e.g. tenant cookie domain kanera.example.com and admin origin admin.example.com.
  ADMIN_COOKIE_DOMAIN: z.preprocess(emptyToUndefined, z.string().optional()),
  COOKIE_DOMAIN: z.string().default("localhost"),
  COOKIE_SECURE: z
    .union([z.string(), z.boolean()])
    .transform((v) => v === true || v === "true")
    .default(false),
  API_PUBLIC_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  UPLOADS_DIR: z.string().default(".data/uploads"),
  S3_ENDPOINT: z.preprocess(emptyToUndefined, z.url().optional()),
  S3_REGION: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  S3_BUCKET: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  S3_ACCESS_KEY_ID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  S3_SECRET_ACCESS_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  S3_PUBLIC_URL_PREFIX: z.preprocess(emptyToUndefined, z.url().optional()),
  // Dedicated key for encrypting stored integration secrets (SMTP/S3/webhook). Should be
  // distinct from JWT_SECRET so a token-signing key compromise does not also expose secrets;
  // when unset, secrets.ts falls back to JWT_SECRET and warns. Min 32 chars (e.g. openssl rand -hex 32).
  SECRETS_ENCRYPTION_KEY: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  GITHUB_APP_ID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  GITHUB_APP_SLUG: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  GITHUB_APP_PRIVATE_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  TRELLO_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  SMTP_HOST: z.preprocess(emptyToUndefined, z.string().optional()),
  SMTP_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).optional()),
  SMTP_SECURITY: z.enum(["none", "starttls", "tls"]).default("starttls"),
  SMTP_USER: z.preprocess(emptyToUndefined, z.string().optional()),
  SMTP_PASSWORD: z.preprocess(emptyToUndefined, z.string().optional()),
  SMTP_FROM_EMAIL: z.preprocess(emptyToUndefined, z.email().optional()),
  SMTP_FROM_NAME: z.preprocess(emptyToUndefined, z.string().optional()),
  SMTP_IDENTITY_DOMAIN: z.preprocess(emptyToUndefined, z.string().min(1).max(255).optional()),
  INTERNAL_NOTIFICATION_EMAILS: z.preprocess(commaSeparatedEmails, z.array(z.email()).default([])),
  // Lifetime of a support-session token minted by the management portal. Kept short and with NO refresh
  // companion so a support session cannot silently persist; the operator re-mints when it lapses. Hard
  // upper bound of 8h so a config typo can't mint day-long, non-revocable-until-expiry impersonation tokens.
  SUPPORT_SESSION_TTL_MINUTES: z.coerce.number().int().positive().max(480).default(60),
  })
  .superRefine((value, ctx) => {
    // Hosted mode is license-restricted to Kanera-operated deployments. This private token is license
    // enforcement functionality; it is required anywhere except local dev/test services, so running a
    // server with NODE_ENV=development does not bypass the gate.
    if (
      value.KANERA_DEPLOYMENT_MODE === "hosted" &&
      !(
        value.KANERA_HOSTED_MODE_TOKEN && matchesSha256(value.KANERA_HOSTED_MODE_TOKEN, hostedModeTokenSha256) ||
        value.NODE_ENV !== "production" &&
          isLocalUrl(value.WEB_ORIGIN) &&
          isLocalUrl(value.DATABASE_URL) &&
          isLocalUrl(value.REDIS_URL)
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["KANERA_HOSTED_MODE_TOKEN"],
        message: "hosted mode is unavailable in this deployment",
      });
    }
    if (value.NODE_ENV !== "production") return;
    const developmentSecrets = new Map<string, string>([
      ["JWT_SECRET", "change-me-to-a-long-random-string"],
      ["MFA_ENCRYPTION_KEY", "change-me-to-a-distinct-32-character-random-string"],
      ["MEDIA_SIGNING_SECRET", "change-me-to-a-separate-long-random-string"],
      ["ADMIN_JWT_SECRET", "change-me-to-a-distinct-long-random-string"],
    ]);
    for (const [key, placeholder] of developmentSecrets) {
      if (value[key as keyof typeof value] === placeholder) {
        ctx.addIssue({ code: "custom", path: [key], message: `${key} must not use the documented development placeholder in production` });
      }
    }
    if (!value.SECRETS_ENCRYPTION_KEY || value.SECRETS_ENCRYPTION_KEY === value.JWT_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["SECRETS_ENCRYPTION_KEY"],
        message: "SECRETS_ENCRYPTION_KEY must be set and distinct from JWT_SECRET in production",
      });
    }
  })
  .transform((value) => ({
    ...value,
    API_PUBLIC_URL: value.API_PUBLIC_URL ?? value.WEB_ORIGIN,
    KANERA_ENVIRONMENT: value.KANERA_ENVIRONMENT ?? (value.NODE_ENV === "production" ? "production" : value.NODE_ENV),
  }));
}

export const environmentSchema = createEnvironmentSchema();

export function createMainApiEnvironmentSchema(options: EnvironmentSchemaOptions = {}) {
  return createEnvironmentSchema(options).superRefine((value, ctx) => {
  if (value.ADMIN_JWT_SECRET && value.ADMIN_JWT_SECRET === value.JWT_SECRET) {
    ctx.addIssue({ code: "custom", path: ["ADMIN_JWT_SECRET"], message: "ADMIN_JWT_SECRET must differ from JWT_SECRET" });
  }
  if (value.KANERA_DEPLOYMENT_MODE !== "hosted") return;
  for (const key of [
    "STRIPE_SECRET_KEY",
    "STRIPE_PUBLISHABLE_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_ID_PRO_MONTHLY",
    "STRIPE_PRICE_ID_PRO_ANNUAL",
  ] as const) {
    if (!value[key]) ctx.addIssue({ code: "custom", path: [key], message: `${key} is required when KANERA_DEPLOYMENT_MODE=hosted` });
  }
  });
}

export const mainApiEnvironmentSchema = createMainApiEnvironmentSchema();

// Shared modules (DB, Redis, mailer) are imported by every executable. Avoid applying main-API-only
// hosted billing requirements while the dedicated admin entry point is loading that shared graph.
const isAdminProcess = process.argv.some((arg) => /(?:admin-index|start:admin-api)/.test(arg));
export const env = (isAdminProcess ? environmentSchema : mainApiEnvironmentSchema).parse(process.env);
export type Env = z.infer<typeof mainApiEnvironmentSchema>;
