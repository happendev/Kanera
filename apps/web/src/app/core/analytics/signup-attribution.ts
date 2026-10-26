import type { SignupBody } from "@kanera/shared/dto";
import { KANERA_CONSENT_COOKIE, parseConsentChoice } from "../consent/cookie-consent.service";

function cookie(name: string): string | undefined {
  const prefix = `${name}=`;
  const raw = document.cookie.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith(prefix));
  try { return raw ? decodeURIComponent(raw.slice(prefix.length)) : undefined; } catch { return undefined; }
}

/** Optional first-touch acquisition. Never attach old cookies after rejection or without consent. */
export function signupAcquisition(): SignupBody["analyticsAttribution"] {
  const consent = parseConsentChoice(cookie(KANERA_CONSENT_COOKIE) ?? null);
  if (!consent?.analytics || navigator.doNotTrack === "1") return undefined;
  const url = new URL(window.location.href);
  let referringDomain: string | undefined;
  try { referringDomain = document.referrer ? new URL(document.referrer).hostname : undefined; } catch { /* Invalid referrer. */ }
  // Moving between our own pages is not a new referral source.
  if (referringDomain === "kanera.app" || referringDomain?.endsWith(".kanera.app")) referringDomain = undefined;
  const value = (key: string, parameter?: string, limit = 120) =>
    (cookie(`kanera_analytics_${key}`) || (parameter ? url.searchParams.get(parameter) : undefined))?.trim().slice(0, limit) || undefined;
  const savedLanding = value("landing_page", undefined, 256);
  const savedReferrer = value("referring_domain", undefined, 253) || referringDomain;
  const captured = Date.parse(value("captured_at") || "");
  return {
    source: value("source", "utm_source") || referringDomain?.slice(0, 120) || "direct",
    medium: value("medium", "utm_medium") || (referringDomain ? "referral" : "none"),
    campaign: value("campaign", "utm_campaign") || "none",
    content: value("content", "utm_content"),
    term: value("term", "utm_term"),
    landing_page: savedLanding && /^\/[^?#]*$/.test(savedLanding) ? savedLanding : url.pathname.slice(0, 256),
    referring_domain: savedReferrer && /^[a-zA-Z0-9.-]+$/.test(savedReferrer) ? savedReferrer : undefined,
    captured_at: Number.isFinite(captured) ? new Date(captured).toISOString() : new Date().toISOString(),
    consented_at: consent.updatedAt,
    consent_version: 1,
    fbclid: value("fbclid", "fbclid", 1024),
    gclid: value("gclid", "gclid", 1024),
    li_fat_id: value("li_fat_id", "li_fat_id", 1024),
    msclkid: value("msclkid", "msclkid", 1024),
  };
}
