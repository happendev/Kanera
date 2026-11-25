// Decides whether a visitor must opt in before optional analytics runs. Kept in step with
// Kanera-site's src/lib/consent-region.ts, since both share the .kanera.app consent cookie.
//
// Opt-in consent is required for visitors in the EEA, the UK, and Switzerland (GDPR, UK GDPR and
// PECR, the revised Swiss FADP). Everywhere else analytics starts on by default, and the visitor
// can still switch it off from account settings.
//
// The country is Cloudflare's CF-IPCountry, which the API echoes in /auth/config. When it is
// unknown (Cloudflare bypassed, local proxy) the browser's time zone decides, and an unknown time
// zone or a Global Privacy Control signal falls back to asking.

import { viewerTimeZone } from "../../shared/day-key.util";

const CONSENT_COUNTRIES = new Set([
  // EU member states
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV",
  "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  // EU outermost regions and Åland, which Cloudflare reports under their own codes
  "AX", "GF", "GP", "MQ", "RE", "YT", "MF",
  // Rest of the EEA, the UK and its Crown dependencies, Gibraltar, and Switzerland
  "IS", "LI", "NO", "GB", "GG", "JE", "IM", "GI", "CH",
]);

// Over-inclusive on purpose: a European time zone outside the EEA only means the banner shows.
// viewerTimeZone() reports an unknown zone as UTC, so UTC (and Etc/*) also asks.
const CONSENT_TIME_ZONE = /^(UTC$|Etc\/|Europe\/|Atlantic\/(Azores|Canary|Faroe|Madeira|Reykjavik)$|Indian\/(Reunion|Mayotte)$|America\/(Cayenne|Guadeloupe|Martinique|Marigot)$)/;

function timeZoneRequiresConsent(): boolean {
  try {
    return CONSENT_TIME_ZONE.test(viewerTimeZone());
  } catch {
    return true;
  }
}

export function analyticsRequiresOptIn(country: string | null | undefined): boolean {
  if ((navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true) return true;
  if (country && /^[A-Z]{2}$/.test(country)) return CONSENT_COUNTRIES.has(country);
  return timeZoneRequiresConsent();
}
