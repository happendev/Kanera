import { refreshTokens, users } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { db } from "../db.js";
import { env } from "../env.js";
import { cookieDomainAttribute } from "../lib/cookie-domain.js";
import { getUploadEntitlements } from "../lib/entitlements.js";
import { unauthorized } from "../lib/errors.js";
import { isClientAdminRole, listActiveOrganisations, resolveActiveOrganisationContext, type ActiveOrganisation } from "../lib/client-membership.js";
import { withSignedMedia } from "../lib/media-keys.js";
import { getEntitlements } from "../lib/tier-limits.js";
import { newRefreshToken } from "./jwt.js";

export const REFRESH_COOKIE = "kanera_rt";

export function refreshCookieOptions() {
  return {
    httpOnly: true,
    // Refresh is sent only to /auth. SameSite=Lax is the CSRF boundary for this cookie.
    sameSite: "lax" as const,
    secure: env.COOKIE_SECURE,
    domain: cookieDomainAttribute(env.COOKIE_DOMAIN),
    path: "/auth",
    maxAge: env.JWT_REFRESH_TTL_DAYS * 86_400,
  };
}

async function accountPayload(clientId: string) {
  // Entitlements and storage usage always describe the active organisation, not the identity's
  // home organisation. The home id remains only the avatar/media storage anchor.
  const { billingStatus, currentPeriodEnd, plan, ...storageUsage } = await getUploadEntitlements(db, clientId);
  return { storageUsage, entitlements: getEntitlements(plan, billingStatus, currentPeriodEnd) };
}

export async function authUserPayload(userId: string, requestedClientId?: string, knownOrganisations?: ActiveOrganisation[]) {
  const [identity] = await db
    .select({
      id: users.id,
      homeClientId: users.clientId,
      email: users.email,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      timezone: users.timezone,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!identity) throw unauthorized();
  const organisations = knownOrganisations ?? await listActiveOrganisations(userId);
  const active = requestedClientId
    ? organisations.find((organisation) => organisation.clientId === requestedClientId)
    : (await resolveActiveOrganisationContext(userId)).active;
  if (!active) throw unauthorized();
  return {
    id: identity.id,
    clientId: active.clientId,
    activeClientId: active.clientId,
    email: identity.email,
    displayName: identity.displayName,
    avatarUrl: withSignedMedia(identity.homeClientId, { avatarUrl: identity.avatarUrl }).avatarUrl,
    timezone: identity.timezone,
    orgName: active.name,
    logoUrl: active.logoUrl,
    deploymentMode: env.KANERA_DEPLOYMENT_MODE,
    kaneraEnvironment: env.KANERA_ENVIRONMENT,
    hasWorkspace: active.hasWorkspace,
    role: active.role,
    isClientAdmin: isClientAdminRole(active.role),
    organisations: organisations.map(({ addedAt: _addedAt, analyticsExcluded: _analyticsExcluded, requireMfa: _requireMfa, ...organisation }) => organisation),
    // Organisations carry independent plans and billing, so creation is not identity-limited.
    canCreateOrganisation: true,
    ...(await accountPayload(active.clientId)),
    analyticsExcluded: active.analyticsExcluded,
  };
}

export async function issueUserSession(
  app: FastifyInstance,
  userId: string,
  reply: FastifyReply,
  requestedClientId?: string,
  knownContext?: { active: ActiveOrganisation | null; organisations: ActiveOrganisation[] },
) {
  const context = knownContext ?? await resolveActiveOrganisationContext(userId, requestedClientId);
  const active = context.active;
  if (!active) throw unauthorized();
  await db.update(users).set({ activeClientId: active.clientId, updatedAt: new Date() }).where(eq(users.id, userId));
  const accessToken = app.jwt.sign({ sub: userId, cid: active.clientId, role: active.role });
  const refresh = newRefreshToken();
  await db.insert(refreshTokens).values({ userId, tokenHash: refresh.hash, expiresAt: refresh.expiresAt });
  reply.setCookie(REFRESH_COOKIE, refresh.raw, refreshCookieOptions());
  return { status: "authenticated" as const, accessToken, user: await authUserPayload(userId, active.clientId, context.organisations) };
}
