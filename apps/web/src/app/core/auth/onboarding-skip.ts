import { onboardingSkippedKey } from "../browser/browser-contracts";
import type { AuthUser } from "./auth.service";

type SkipIdentity = Pick<AuthUser, "id" | "clientId" | "activeClientId"> | null | undefined;

function skipKey(user: SkipIdentity): string | null {
  if (!user) return null;
  return onboardingSkippedKey(user.id, user.activeClientId ?? user.clientId);
}

/**
 * Whether this user, in this organisation, has dismissed first-run onboarding on this device.
 *
 * The flag is only ever consulted while `hasWorkspace` is false, so it never needs clearing: once a
 * standard workspace exists the guard stops looking at it. Storage that is blocked or cleared simply
 * degrades to today's behaviour (the guided setup is offered again).
 */
export function isOnboardingSkipped(user: SkipIdentity): boolean {
  const key = skipKey(user);
  if (!key) return false;
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function markOnboardingSkipped(user: SkipIdentity): void {
  const key = skipKey(user);
  if (!key) return;
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Private mode or disabled storage: the skip still navigates, it just does not persist.
  }
}
