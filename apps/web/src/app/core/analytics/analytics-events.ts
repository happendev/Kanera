export type RegistrationMethod = "email" | "google" | "microsoft" | "other_sso";
export type ImportSource = "trello" | "kanera" | "csv" | "other";

export interface AnalyticsEventMap {
  registration_started: { registration_method: RegistrationMethod; source_surface: "signup" | "invite" };
  import_started: { import_source: ImportSource };
  checkout_started: { plan: "pro"; billing_interval: "monthly" | "annual" };
  upgrade_page_viewed: { source_surface: "account_settings" };
}

export type AnalyticsEventName = keyof AnalyticsEventMap;
export type AnalyticsEventProperties<TEvent extends AnalyticsEventName> = AnalyticsEventMap[TEvent];
