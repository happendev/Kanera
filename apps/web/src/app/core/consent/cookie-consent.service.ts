import { Injectable, computed, signal } from "@angular/core";

export const KANERA_CONSENT_COOKIE = "kanera_cookie_consent";
export const KANERA_CONSENT_VERSION = 1;
export const CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;
const CONSENT_MAX_AGE_MS = CONSENT_MAX_AGE_SECONDS * 1_000;

export interface CookieConsentChoice {
  version: number;
  necessary: true;
  analytics: boolean;
  marketing: false;
  updatedAt: string;
}

export function parseConsentChoice(raw: string | null, now = Date.now()): CookieConsentChoice | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(decodeURIComponent(raw)) as Partial<CookieConsentChoice>;
    const updatedAt = typeof value.updatedAt === "string" ? Date.parse(value.updatedAt) : Number.NaN;
    if (
      value.version !== KANERA_CONSENT_VERSION
      || value.necessary !== true
      || typeof value.analytics !== "boolean"
      || value.marketing !== false
      || !Number.isFinite(updatedAt)
      || updatedAt > now + 5 * 60 * 1_000
      || now - updatedAt > CONSENT_MAX_AGE_MS
    ) return null;
    return value as CookieConsentChoice;
  } catch {
    return null;
  }
}

function cookieValue(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${name}=`;
  const match = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return match?.slice(prefix.length) ?? null;
}

export function readCookieConsent(): CookieConsentChoice | null {
  return parseConsentChoice(cookieValue(KANERA_CONSENT_COOKIE));
}

function sharedCookieDomain(hostname: string): string | null {
  return hostname === "kanera.app" || hostname.endsWith(".kanera.app") ? ".kanera.app" : null;
}

function expireCookie(name: string, domain?: string): void {
  document.cookie = `${name}=; Max-Age=0; Path=/${domain ? `; Domain=${domain}` : ""}; SameSite=Lax`;
}

/** Remove optional PostHog state while leaving necessary authentication and consent state alone. */
export function clearKnownAnalyticsStorage(): void {
  if (typeof window === "undefined") return;
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith("ph_")) storage.removeItem(key);
    }
  }

  const cookieNames = document.cookie
    .split(";")
    .map((cookie) => cookie.trim().split("=")[0])
    .filter((name) => name.startsWith("ph_") || name.startsWith("kanera_analytics_"));
  const sharedDomain = sharedCookieDomain(window.location.hostname);
  for (const name of cookieNames) {
    expireCookie(name);
    expireCookie(name, window.location.hostname);
    if (sharedDomain) expireCookie(name, sharedDomain);
  }
}

@Injectable({ providedIn: "root" })
export class CookieConsentService {
  private readonly _available = signal(false);
  private readonly _choice = signal<CookieConsentChoice | null>(readCookieConsent());
  private readonly _settingsRequest = signal(0);

  readonly available = this._available.asReadonly();
  readonly choice = this._choice.asReadonly();
  readonly analyticsAllowed = computed(() => this._available() && this._choice()?.analytics === true);
  readonly settingsRequest = this._settingsRequest.asReadonly();

  configure(available: boolean): void {
    this._available.set(available);
  }

  save(analytics: boolean): CookieConsentChoice {
    const choice: CookieConsentChoice = {
      version: KANERA_CONSENT_VERSION,
      necessary: true,
      analytics,
      marketing: false,
      updatedAt: new Date().toISOString(),
    };
    const sharedDomain = sharedCookieDomain(window.location.hostname);
    const attributes = [
      `Max-Age=${CONSENT_MAX_AGE_SECONDS}`,
      "Path=/",
      sharedDomain ? `Domain=${sharedDomain}` : "",
      "SameSite=Lax",
      window.location.protocol === "https:" ? "Secure" : "",
    ].filter(Boolean).join("; ");
    document.cookie = `${KANERA_CONSENT_COOKIE}=${encodeURIComponent(JSON.stringify(choice))}; ${attributes}`;
    this._choice.set(choice);
    if (!analytics) clearKnownAnalyticsStorage();
    return choice;
  }

  openSettings(): void {
    if (this._available()) this._settingsRequest.update((value) => value + 1);
  }
}
