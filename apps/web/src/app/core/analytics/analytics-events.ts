import type { SignInProvider } from "@kanera/shared/schema";

export type ImportSource = "trello" | "kanera" | "csv" | "other";

export type PremiumFeature = "members" | "boards" | "automation_rules" | "automation_executions" | "guests" | "api" | "integrations";
export type UpgradeSource =
  | "home"
  | "app_shell"
  | "workspace_settings"
  | "organisation_users"
  | "account_plan"
  | "account_settings"
  | "board_members"
  | "onboarding";

export interface PlanLimitAnalyticsProperties {
  limit_type: PremiumFeature;
  current_usage: number;
  plan_limit: number;
  member_count: number;
  active_member_count: number;
  board_count: number;
  trial_days_remaining: number;
  upgrade_source: UpgradeSource;
}

// Steps of the two-step signup form, in order. A wrong emailed code reports as
// account_creation_failed after code_submitted.
export type SignupStep =
  | "details_submitted"
  | "code_requested"
  | "code_resent"
  | "code_request_failed"
  | "code_submitted"
  | "account_creation_failed";

// Pages that show the Google / Microsoft / GitHub buttons. Any of them can create an account: a
// provider sign-in with an unknown email continues into signup.
export type ProviderAuthPage = "signup" | "login" | "invite" | "board_invite";
// What happened after the provider sent the person back. The server's registration_completed
// (signup_method = provider) is the success step; these are the stops before it.
export type ProviderSignInStep = "signup_details_shown" | "signup_details_submitted" | "email_code_shown" | "failed";

export interface AnalyticsEventMap {
  registration_started: {
    anonymous_id: string;
    source: string;
    medium: string;
    campaign: string;
    landing_page: string;
    content?: string;
    term?: string;
    event_version: number;
  };
  signup_step: { step: SignupStep; error_code?: string; event_version: number };
  sign_in_provider_selected: { provider: SignInProvider; auth_page: ProviderAuthPage; event_version: number };
  sign_in_provider_step: { step: ProviderSignInStep; provider?: SignInProvider; error_code?: string; event_version: number };
  import_started: { import_source: ImportSource };
  premium_feature_attempted: PlanLimitAnalyticsProperties & { premium_feature: PremiumFeature };
  plan_limit_warning_seen: PlanLimitAnalyticsProperties;
  plan_limit_reached: PlanLimitAnalyticsProperties;
  upgrade_modal_viewed: PlanLimitAnalyticsProperties & { premium_feature: PremiumFeature };
  upgrade_modal_dismissed: PlanLimitAnalyticsProperties & { premium_feature: PremiumFeature };
  pricing_viewed_in_app: {
    plan_code: "free" | "pro_trial" | "pro";
    trial_days_remaining: number;
    upgrade_source: UpgradeSource;
  };
  downgrade_impact_viewed: {
    affected_board_count: number;
    affected_member_count: number;
    affected_feature_count: number;
    trial_days_remaining: number;
    upgrade_source: UpgradeSource;
  };
  upgrade_page_viewed: { source_surface: "account_settings" };
}

export type AnalyticsEventName = keyof AnalyticsEventMap;
