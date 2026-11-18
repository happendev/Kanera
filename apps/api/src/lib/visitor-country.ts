import type { IncomingHttpHeaders } from "node:http";

// Country-level location for hosted product analytics, without sending anyone's IP address to
// PostHog. Cloudflare adds CF-IPCountry to every request it forwards; only a two-letter ISO code
// is accepted, so XX (unknown), T1 (Tor), and any other value are dropped. PostHog's own GeoIP
// lookup stays disabled, so no city, region, postcode, or coordinates are derived.
//
// The header is analytics context only and is never used for access, billing, or rate limits, so
// it is read without the Cloudflare-peer check that CF-Connecting-IP needs.
export function visitorCountryFromHeaders(headers: IncomingHttpHeaders): string | null {
  const raw = headers["cf-ipcountry"];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase();
  return value && /^[A-Z]{2}$/.test(value) && value !== "XX" ? value : null;
}

const countryNames = (() => {
  try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; }
})();

/**
 * PostHog's standard country fields, so its built-in country breakdowns and world map work while
 * $geoip_disable keeps its IP lookup off. Empty when the country is unknown.
 */
export function analyticsCountryProperties(country: string | null | undefined): { $geoip_country_code?: string; $geoip_country_name?: string } {
  if (!country) return {};
  let name: string | undefined;
  try { name = countryNames?.of(country); } catch { name = undefined; }
  return { $geoip_country_code: country, ...(name && name !== country ? { $geoip_country_name: name } : {}) };
}
