import type { dto } from "@kanera/shared";
import { clientMembers, clients, refreshTokens, users } from "@kanera/shared/schema";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { cancelBillingForPermanentDeletion } from "../../lib/billing.js";
import { resolveActiveOrganisationContext } from "../../lib/client-membership.js";
import { AppError, badRequest } from "../../lib/errors.js";
import { sendOpsAlert } from "../../lib/ops-alerts.js";
import { disconnectUserRealtimeSockets } from "../../realtime/io.js";
import { loadClient } from "./client-queries.js";

/**
 * `DELETE /clients/me`: confirms the name, cancels billing, marks the organisation for permanent
 * deletion and re-homes its members. Returns the acting user's next organisation context so the
 * route can issue a new session or log them out.
 */
export async function deleteClient({
  auth,
  body,
  log,
  request,
}: {
  auth: AuthClaims;
  body: dto.DeleteClientBody;
  log: FastifyBaseLogger;
  request: { id: string; method: string; url: string };
}) {
  const current = await loadClient(auth.cid);
  if (body.confirmationName !== current.name) throw badRequest("organisation name does not match");

  // Storage/database removal is intentionally asynchronous, but recurring billing is not: do
  // not accept the deletion until Stripe confirms the Customer is terminal and non-billable.
  // The worker repeats this idempotently before purging local billing identifiers.
  try {
    await cancelBillingForPermanentDeletion(auth.cid);
  } catch (error) {
    log.error({ err: error, clientId: auth.cid }, "failed to cancel billing before organisation deletion");
    void sendOpsAlert({
      service: "api",
      type: "error",
      title: "Organisation billing cancellation failed",
      requestId: request.id,
      method: request.method,
      url: request.url,
      statusCode: 503,
      error: new Error(`Stripe billing cancellation failed before deleting organisation ${auth.cid}`),
      throttleKey: `organisation-delete:billing:${auth.cid}`,
    }, { log });
    throw new AppError(
      503,
      "BILLING_CANCELLATION_FAILED",
      "Billing cancellation could not be confirmed, so the organisation was not deleted. Please try again.",
    );
  }

  const memberRows = await db.select({ userId: clientMembers.userId })
    .from(clientMembers).where(eq(clientMembers.clientId, auth.cid));
  const memberUserIds = [...new Set(memberRows.map((row) => row.userId))];
  const requestedAt = new Date();
  await db.transaction(async (tx) => {
    // Inaccessibility is the synchronous boundary. Storage and the heavy owned graph are purged by
    // the worker from the durable request marker, so this request remains fast and restart-safe.
    await tx.update(clients).set({
      deletedAt: requestedAt,
      permanentDeletionRequestedAt: requestedAt,
      updatedAt: requestedAt,
    }).where(and(eq(clients.id, auth.cid), isNull(clients.permanentDeletionRequestedAt)));

    for (const userId of memberUserIds) {
      const [identity] = await tx.select({ homeClientId: users.clientId, activeClientId: users.activeClientId })
        .from(users).where(eq(users.id, userId)).limit(1);
      if (!identity) continue;
      const [fallback] = await tx.select({ clientId: clientMembers.clientId })
        .from(clientMembers)
        .innerJoin(clients, eq(clients.id, clientMembers.clientId))
        .where(and(
          eq(clientMembers.userId, userId),
          ne(clientMembers.clientId, auth.cid),
          isNull(clientMembers.suspendedAt),
          isNull(clientMembers.removedAt),
          isNull(clients.suspendedAt),
          isNull(clients.deletedAt),
        ))
        .orderBy(asc(clientMembers.addedAt), asc(clientMembers.clientId))
        .limit(1);
      await tx.update(users).set({
        ...(identity.activeClientId === auth.cid ? { activeClientId: fallback?.clientId ?? null } : {}),
        ...(identity.homeClientId === auth.cid
          ? { ...(fallback ? { clientId: fallback.clientId } : {}), avatarUrl: null }
          : {}),
        needsOrganisationOnLoginAt: fallback ? null : requestedAt,
        updatedAt: requestedAt,
      }).where(eq(users.id, userId));
    }
    // Remove authority immediately; the purge remains idempotent if this row set is already empty.
    await tx.delete(clientMembers).where(eq(clientMembers.clientId, auth.cid));
  });

  for (const userId of memberUserIds) disconnectUserRealtimeSockets(userId);
  await db.update(refreshTokens).set({ revokedAt: requestedAt })
    .where(and(eq(refreshTokens.userId, auth.sub), isNull(refreshTokens.revokedAt)));
  return resolveActiveOrganisationContext(auth.sub);
}
