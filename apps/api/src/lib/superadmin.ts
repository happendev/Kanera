import { env } from "../env.js";

// Whether an email belongs to a platform operator allowed to start cross-tenant support sessions.
// The allowlist is env-only (SUPERADMIN_EMAILS) so the privilege lives with whoever controls the
// deployment, never in a tenant DB row that a bug or compromised account could escalate. An empty
// allowlist (the default) means the feature is off and this always returns false — fail closed.
export function isSuperadminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  if (env.SUPERADMIN_EMAILS.length === 0) return false;
  const normalized = email.trim().toLowerCase();
  // Emails are citext (case-insensitive) in the DB, so compare case-insensitively here too.
  return env.SUPERADMIN_EMAILS.some((allowed) => allowed.trim().toLowerCase() === normalized);
}
