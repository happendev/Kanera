import { STORAGE_KEYS } from "./browser-contracts";

// Persist the boundary across reloads and tabs. Failed cleanup quarantines private storage
// while it is retried; a completed logout also stops delayed draft/snapshot writes.
export const CLEANUP_PENDING_KEY = "kanera:cleanup-pending";

export const SESSION_CLEANUP_KEY = "kanera:session-cleanup";

export function sessionStorageBlocked(): boolean {
  try { return localStorage.getItem(SESSION_CLEANUP_KEY) !== null || localStorage.getItem(CLEANUP_PENDING_KEY) !== null; } catch { return true; }
}

const DEVICE_KEYS = new Set<string>([
  STORAGE_KEYS.THEME, STORAGE_KEYS.ACCENT, STORAGE_KEYS.DENSITY, STORAGE_KEYS.LOCALE,
  STORAGE_KEYS.LOGOUT_SYNC, SESSION_CLEANUP_KEY, CLEANUP_PENDING_KEY,
]);

export function clearSessionStorage(preserveIdentity = false): void {
  for (const storage of [localStorage, sessionStorage]) {
    for (const key of Object.keys(storage)) {
      // Leave unrelated applications and device appearance/language alone. All Kanera account
      // preferences (including dynamic board/view keys and legacy drafts) share these prefixes.
      if (preserveIdentity && key === STORAGE_KEYS.OFFLINE_IDENTITY) continue;
      if (/^kanera[:._-]/.test(key) && !DEVICE_KEYS.has(key)) storage.removeItem(key);
    }
  }
}
