export type AnalyticsRuntimeConfig = {
  enabled: true;
  provider: "posthog";
  projectKey: string;
  apiHost: string;
};

export type AnalyticsUserIdentity = { userId: string };

export type AnalyticsOrganizationIdentity = {
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
};

export type AnalyticsPageView = {
  route_pattern: string;
  page_category: "authentication" | "onboarding" | "workspace" | "board" | "team" | "settings" | "billing";
  is_authenticated: boolean;
};
