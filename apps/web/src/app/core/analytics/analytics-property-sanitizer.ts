import type { Properties } from "posthog-js";

const allowedByEvent: Record<string, ReadonlySet<string>> = {
  registration_started: new Set(["registration_method", "source_surface"]),
  import_started: new Set(["import_source"]),
  checkout_started: new Set(["plan", "billing_interval"]),
  upgrade_page_viewed: new Set(["source_surface"]),
  $pageview: new Set(["route_pattern", "page_category", "is_authenticated"]),
};

const allowedGroupProperties = new Set([
  "deployment_mode",
  "plan",
  "billing_interval",
  "trial_status",
  "member_count_band",
  "workspace_age_band",
  "has_imported_board",
]);

const allowedPersonAttributionProperties = new Set([
  "$initial_utm_source",
  "$initial_utm_medium",
  "$initial_utm_campaign",
  "$initial_utm_content",
  "$initial_utm_term",
  "$initial_referring_domain",
  "$utm_source",
  "$utm_medium",
  "$utm_campaign",
  "$utm_content",
  "$utm_term",
  "$referring_domain",
]);

// sanitize_properties receives PostHog's fully assembled event properties, not only the
// properties supplied by Kanera. These fields are required for ingestion, deduplication, and
// pseudonymous identity/session continuity; dropping `token` makes PostHog reject the event.
const allowedTransportProperties = new Set([
  "token",
  "distinct_id",
  "$device_id",
  "$session_id",
  "$window_id",
  "$lib",
  "$lib_version",
  "$insert_id",
  "$time",
  "$sent_at",
  "$process_person_profile",
]);

function isAllowedTransportProperty(property: string): boolean {
  return allowedTransportProperties.has(property);
}

// This is the final provider boundary. Even if a caller circumvents TypeScript, content fields,
// entity names, raw routes, and query strings cannot cross it.
export function sanitizeAnalyticsProperties(properties: Properties, eventName: string): Properties {
  if (eventName === "$identify") {
    return Object.fromEntries(Object.entries(properties).flatMap(([key, value]) => {
      if (isAllowedTransportProperty(key)) return [[key, value]];
      if (key === "$anon_distinct_id") return [[key, value]];
      if ((key !== "$set" && key !== "$set_once") || !value || typeof value !== "object" || Array.isArray(value)) return [];
      const attribution = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(([property]) => allowedPersonAttributionProperties.has(property)),
      );
      return Object.keys(attribution).length > 0 ? [[key, attribution]] : [];
    }));
  }
  if (eventName === "$groupidentify") {
    return Object.fromEntries(Object.entries(properties).flatMap(([key, value]) => {
      if (isAllowedTransportProperty(key)) return [[key, value]];
      if (key === "$group_type" || key === "$group_key") return [[key, value]];
      if (key !== "$group_set" || !value || typeof value !== "object" || Array.isArray(value)) return [];
      const groupProperties = value as Record<string, unknown>;
      return [[key, Object.fromEntries(Object.entries(groupProperties).filter(([property]) => allowedGroupProperties.has(property)))]];
    }));
  }
  const allowed = allowedByEvent[eventName] ?? new Set<string>();
  return Object.fromEntries(Object.entries(properties).filter(
    ([key]) => allowed.has(key) || key === "$groups" || isAllowedTransportProperty(key),
  ));
}
