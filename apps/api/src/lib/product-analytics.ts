import { clients } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { PostHog } from "posthog-node";
import { db } from "../db.js";
import { env } from "../env.js";

export type PlanCode = "free" | "pro_trial" | "pro";
export type BillingPeriod = "monthly" | "annual" | "not_selected";
export type SubscriptionPaymentReason =
  | "subscription_create"
  | "subscription_cycle"
  | "subscription_update"
  | "subscription_threshold"
  | "other";
export type CardCreationSource = "web" | "public_api" | "mcp";
export const ANALYTICS_EVENT_VERSION = 1;

export function analyticsCardCreationSource(
  authKind: "user" | "apiKey" | "support" | undefined,
  clientHeader: string | string[] | undefined,
): CardCreationSource {
  if (authKind !== "apiKey") return "web";
  return clientHeader === "mcp" ? "mcp" : "public_api";
}

export function analyticsPlanCode(billingStatus: string): PlanCode {
  if (billingStatus === "trialing") return "pro_trial";
  if (billingStatus === "active" || billingStatus === "past_due") return "pro";
  return "free";
}

export function analyticsCountBand(count: number): string {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 3) return "2_3";
  if (count <= 10) return "4_10";
  return "11_plus";
}

// Seat purchases band differently from member counts (commercial tiers, not collaboration size), so the
// buckets intentionally differ from analyticsCountBand. Kept here so every seat_band emitter stays aligned.
export function seatBand(seats: number): string {
  if (seats <= 1) return "1";
  if (seats <= 4) return "2_4";
  if (seats <= 10) return "5_10";
  return "over_10";
}

export function analyticsDaysSince(startedAt: Date, now = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 86_400_000));
}

export interface ServerAnalyticsEventMap {
  registration_completed: {
    user_id: string;
    source: string;
    medium: string;
    campaign: string;
    event_version: number;
  };
  workspace_created: { user_id: string; workspace_id: string; plan_code: PlanCode; event_version: number };
  board_created: { user_id: string; workspace_id: string; board_count_band: string; event_version: number };
  card_created: {
    user_id: string;
    workspace_id: string;
    creation_source: CardCreationSource;
    event_version: number;
  };
  board_imported: {
    user_id: string;
    workspace_id: string;
    import_source_category: "trello" | "kanera" | "csv" | "other";
    event_version: number;
  };
  meaningful_work_created: {
    workspace_id: string;
    threshold_version: string;
    days_since_signup: number;
    event_version: number;
  };
  member_invited: {
    workspace_id: string;
    member_count_band: string;
    days_since_signup: number;
    event_version: number;
  };
  invitation_accepted: {
    workspace_id: string;
    member_count_band: string;
    days_since_signup: number;
    event_version: number;
  };
  collaboration_started: {
    workspace_id: string;
    active_member_band: string;
    days_since_signup: number;
    event_version: number;
  };
  trial_started: {
    workspace_id: string;
    plan_code: PlanCode;
    billing_period: BillingPeriod;
    event_version: number;
  };
  trial_converted: {
    workspace_id: string;
    plan_code: PlanCode;
    billing_period: BillingPeriod;
    event_version: number;
  };
  trial_ended: {
    workspace_id: string;
    plan_code: PlanCode;
    cancellation_category: string;
    event_version: number;
  };
  subscription_checkout_created: {
    workspace_id: string;
    plan_code: PlanCode;
    billing_period: BillingPeriod;
    seat_band: string;
    event_version: number;
  };
  subscription_started: {
    workspace_id: string;
    plan_code: PlanCode;
    billing_period: BillingPeriod;
    seat_band: string;
    currency: string;
    event_version: number;
  };
  subscription_payment_succeeded: {
    workspace_id: string;
    plan_code: PlanCode;
    billing_period: BillingPeriod;
    seat_band: string;
    // Stripe and PostHog revenue events both represent money in the currency's minor unit.
    revenue: number;
    currency: string;
    billing_reason: SubscriptionPaymentReason;
    event_version: number;
  };
  subscription_cancelled: {
    workspace_id: string;
    plan_code: PlanCode;
    cancellation_category: string;
    tenure_band: string;
    event_version: number;
  };
}

export type ServerAnalyticsEventName = keyof ServerAnalyticsEventMap;
export type ServerAnalyticsEvent<TEvent extends ServerAnalyticsEventName = ServerAnalyticsEventName> = {
  [K in TEvent]: {
    event: K;
    distinctId: string;
    organizationId: string;
    properties: ServerAnalyticsEventMap[K];
    supportSession?: boolean;
  }
}[TEvent];

export interface ServerAnalyticsIdentity {
  userId: string;
  organizationId: string;
  supportSession?: boolean;
}

export interface ServerAnalyticsOrganization {
  organizationId: string;
  properties: {
    deployment_mode: "cloud";
    name?: string;
    owner_name?: string;
    owner_email?: string;
    owner_user_id?: string;
    plan?: "free" | "trial" | "paid";
    billing_interval?: "monthly" | "annual";
    trial_status?: "active" | "expired" | "none";
    member_count_band?: string;
    workspace_age_band?: string;
    has_imported_board?: boolean;
  };
}

export interface ProductAnalytics {
  capture<TEvent extends ServerAnalyticsEventName>(event: ServerAnalyticsEvent<TEvent>): Promise<void>;
  identifyUser(input: ServerAnalyticsIdentity): Promise<void>;
  setOrganization(input: ServerAnalyticsOrganization): Promise<void>;
  shutdown(): Promise<void>;
}

const allowedProperties: { [K in ServerAnalyticsEventName]: ReadonlySet<keyof ServerAnalyticsEventMap[K]> } = {
  registration_completed: new Set(["user_id", "source", "medium", "campaign", "event_version"]),
  workspace_created: new Set(["user_id", "workspace_id", "plan_code", "event_version"]),
  board_created: new Set(["user_id", "workspace_id", "board_count_band", "event_version"]),
  card_created: new Set(["user_id", "workspace_id", "creation_source", "event_version"]),
  board_imported: new Set(["user_id", "workspace_id", "import_source_category", "event_version"]),
  meaningful_work_created: new Set(["workspace_id", "threshold_version", "days_since_signup", "event_version"]),
  member_invited: new Set(["workspace_id", "member_count_band", "days_since_signup", "event_version"]),
  invitation_accepted: new Set(["workspace_id", "member_count_band", "days_since_signup", "event_version"]),
  collaboration_started: new Set(["workspace_id", "active_member_band", "days_since_signup", "event_version"]),
  trial_started: new Set(["workspace_id", "plan_code", "billing_period", "event_version"]),
  trial_converted: new Set(["workspace_id", "plan_code", "billing_period", "event_version"]),
  trial_ended: new Set(["workspace_id", "plan_code", "cancellation_category", "event_version"]),
  subscription_checkout_created: new Set(["workspace_id", "plan_code", "billing_period", "seat_band", "event_version"]),
  subscription_started: new Set(["workspace_id", "plan_code", "billing_period", "seat_band", "currency", "event_version"]),
  subscription_payment_succeeded: new Set([
    "workspace_id",
    "plan_code",
    "billing_period",
    "seat_band",
    "revenue",
    "currency",
    "billing_reason",
    "event_version",
  ]),
  subscription_cancelled: new Set(["workspace_id", "plan_code", "cancellation_category", "tenure_band", "event_version"]),
};

export function serverAnalyticsEnabled(): boolean {
  return env.ANALYTICS_ENABLED
    && env.ANALYTICS_PROVIDER === "posthog"
    && env.KANERA_DEPLOYMENT_MODE === "hosted"
    && (env.KANERA_ENVIRONMENT === "production" || env.KANERA_ENVIRONMENT === "staging")
    && !!env.POSTHOG_PROJECT_KEY
    && !!env.POSTHOG_API_HOST;
}

export function sanitizeEventProperties<TEvent extends ServerAnalyticsEventName>(
  event: TEvent,
  properties: ServerAnalyticsEventMap[TEvent],
): ServerAnalyticsEventMap[TEvent] {
  const allowed = allowedProperties[event] as ReadonlySet<string>;
  return Object.fromEntries(Object.entries(properties).filter(([key]) => allowed.has(key))) as ServerAnalyticsEventMap[TEvent];
}

class PostHogProductAnalytics implements ProductAnalytics {
  private readonly pending = new Set<Promise<void>>();
  private readonly client = serverAnalyticsEnabled()
    ? new PostHog(env.POSTHOG_PROJECT_KEY!, {
      // Capture uses the same public project token and ingestion host in browsers and Node.
      // A separate private API key is only for querying/admin APIs, not event ingestion.
      host: env.POSTHOG_API_HOST!,
      flushAt: 20,
      flushInterval: 5_000,
      disableGeoip: true,
    })
    : null;

  private async organizationAllowed(organizationId: string, supportSession = false): Promise<boolean> {
    if (!this.client || supportSession) return false;
    const [organization] = await db
      .select({ analyticsExcluded: clients.analyticsExcluded })
      .from(clients)
      .where(eq(clients.id, organizationId))
      .limit(1);
    return organization?.analyticsExcluded === false;
  }

  private track(operation: Promise<void>): Promise<void> {
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation));
    return operation;
  }

  capture<TEvent extends ServerAnalyticsEventName>(input: ServerAnalyticsEvent<TEvent>): Promise<void> {
    return this.track(this.captureInternal(input));
  }

  private async captureInternal<TEvent extends ServerAnalyticsEventName>(input: ServerAnalyticsEvent<TEvent>): Promise<void> {
    try {
      if (!await this.organizationAllowed(input.organizationId, input.supportSession)) return;
      this.client!.capture({
        distinctId: input.distinctId,
        event: input.event,
        groups: { organization: input.organizationId },
        properties: {
          ...sanitizeEventProperties(input.event, input.properties),
          // Server-authoritative events join an identified browser user without creating profiles on their own.
          $process_person_profile: false,
        },
      });
    } catch {
      // Product writes are authoritative; analytics outages and malformed provider responses are not.
    }
  }

  identifyUser(input: ServerAnalyticsIdentity): Promise<void> {
    return this.track(this.identifyUserInternal(input));
  }

  private async identifyUserInternal(input: ServerAnalyticsIdentity): Promise<void> {
    try {
      if (!await this.organizationAllowed(input.organizationId, input.supportSession)) return;
      this.client!.identify({ distinctId: input.userId, properties: {} });
    } catch {
      // Identification is best-effort and carries no user profile properties.
    }
  }

  setOrganization(input: ServerAnalyticsOrganization): Promise<void> {
    return this.track(this.setOrganizationInternal(input));
  }

  private async setOrganizationInternal(input: ServerAnalyticsOrganization): Promise<void> {
    try {
      if (!await this.organizationAllowed(input.organizationId)) return;
      this.client!.groupIdentify({
        groupType: "organization",
        groupKey: input.organizationId,
        properties: input.properties,
      });
    } catch {
      // Group enrichment must never affect the request that triggered it.
    }
  }

  async shutdown(): Promise<void> {
    try {
      await Promise.all(this.pending);
      if (this.client) await this.client._shutdown(5_000);
    } catch {
      // A provider outage must not prevent a graceful API shutdown.
    }
  }
}

export const productAnalytics: ProductAnalytics = new PostHogProductAnalytics();
