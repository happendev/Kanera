export type ImportSource = "trello" | "kanera" | "csv" | "other";

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
  checkout_started: { plan: "pro"; billing_interval: "monthly" | "annual" };
  upgrade_page_viewed: { source_surface: "account_settings" };
}

export type AnalyticsEventName = keyof AnalyticsEventMap;
export type AnalyticsEventProperties<TEvent extends AnalyticsEventName> = AnalyticsEventMap[TEvent];
