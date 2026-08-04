export type ImportSource = "trello" | "kanera" | "csv" | "other";

export type PremiumFeature = "members" | "boards" | "automation_rules" | "automation_executions" | "guests" | "api" | "integrations";
export type UpgradeSource =
  | "home"
  | "app_shell"
  | "workspace_settings"
  | "organisation_users"
  | "account_plan";

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

export interface AnalyticsEventMap {
  registration_started: {
    anonymous_id: string;
    source: string;
    medium: string;
    campaign: string;
    landing_page: string;
    event_version: number;
  };
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
export type AnalyticsEventProperties<TEvent extends AnalyticsEventName> = AnalyticsEventMap[TEvent];
