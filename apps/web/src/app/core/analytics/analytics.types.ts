export type AnalyticsRuntimeConfig = {
  enabled: true;
  provider: "posthog";
  projectKey: string;
  apiHost: string;
};

export type AnalyticsUserIdentity = {
  userId: string;
  name: string;
  email: string;
};

export type AnalyticsOrganizationIdentity = {
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
};

export type AnalyticsPageView = {
  route_pattern: string;
  page_category: "authentication" | "onboarding" | "workspace" | "board" | "team" | "settings" | "billing";
  is_authenticated: boolean;
};
