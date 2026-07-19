import { clients } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { PostHog } from "posthog-node";
import { db } from "../db.js";
import { env } from "../env.js";

type RegistrationMethod = "email" | "google" | "microsoft" | "other_sso";
type CreationSource = "onboarding" | "invitation" | "admin" | "api";

export interface ServerAnalyticsEventMap {
  account_created: { registration_method: RegistrationMethod; has_attribution: boolean };
  workspace_created: { creation_source: CreationSource; initial_role: "admin" | "member" };
  board_created: { creation_source: CreationSource; is_first_board: boolean; template_type: string };
  board_import_completed: {
    import_source: "trello" | "kanera" | "csv" | "other";
    is_first_board: boolean;
    list_count_band: string;
    card_count_band: string;
    duration_band: string;
  };
  workspace_invitation_created: {
    invitation_method: "link" | "email" | "guest";
    invited_role: "owner" | "admin" | "member" | "editor" | "observer";
    member_count_before: number;
    pending_invitation_count: number;
    is_first_colleague_invitation: boolean;
  };
  workspace_member_joined: {
    join_source: "invitation" | "direct" | "guest_invitation";
    member_count_after: number;
    is_second_member: boolean;
    is_third_member: boolean;
  };
  workspace_activation_completed: {
    activation_path: "board_then_invitation" | "invitation_then_board" | "same_transaction";
    hours_to_activation_band: string;
    board_source: "created" | "imported";
  };
  workspace_qualified: {
    qualification_reason: "three_active_members" | "collaborative_activity" | "both";
    active_member_count: number;
    distinct_collaborator_count: number;
    days_to_qualification_band: string;
  };
  subscription_started: {
    plan: "pro";
    billing_interval: "monthly" | "annual";
    seat_count_band: string;
    trial_conversion: boolean;
    currency: string;
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
  account_created: new Set(["registration_method", "has_attribution"]),
  workspace_created: new Set(["creation_source", "initial_role"]),
  board_created: new Set(["creation_source", "is_first_board", "template_type"]),
  board_import_completed: new Set(["import_source", "is_first_board", "list_count_band", "card_count_band", "duration_band"]),
  workspace_invitation_created: new Set(["invitation_method", "invited_role", "member_count_before", "pending_invitation_count", "is_first_colleague_invitation"]),
  workspace_member_joined: new Set(["join_source", "member_count_after", "is_second_member", "is_third_member"]),
  workspace_activation_completed: new Set(["activation_path", "hours_to_activation_band", "board_source"]),
  workspace_qualified: new Set(["qualification_reason", "active_member_count", "distinct_collaborator_count", "days_to_qualification_band"]),
  subscription_started: new Set(["plan", "billing_interval", "seat_count_band", "trial_conversion", "currency"]),
};

export function serverAnalyticsEnabled(): boolean {
  return env.ANALYTICS_ENABLED
    && env.ANALYTICS_PROVIDER === "posthog"
    && env.KANERA_DEPLOYMENT_MODE === "hosted"
    && (env.KANERA_ENVIRONMENT === "production" || env.KANERA_ENVIRONMENT === "staging")
    && !!env.POSTHOG_SERVER_API_KEY
    && !!env.POSTHOG_SERVER_API_HOST;
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
    ? new PostHog(env.POSTHOG_SERVER_API_KEY!, {
      host: env.POSTHOG_SERVER_API_HOST!,
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
          deployment_mode: "cloud",
          kanera_environment: env.KANERA_ENVIRONMENT,
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
