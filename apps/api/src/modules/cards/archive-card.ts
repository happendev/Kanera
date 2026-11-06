import { cards } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import type { assertCardAccess } from "../../lib/access.js";
import { archiveCards, emitCardArchiveTransition, type CardArchiveTransition } from "../../lib/card-archive.js";
import type { Mailer } from "../../lib/mailer.js";
import { toWireCard } from "../../lib/wire-card.js";

type CardAccessContext = Awaited<ReturnType<typeof assertCardAccess>>;

/**
 * Archives or restores one card through the shared transition (lib/card-archive.ts). The caller has
 * already returned early when the card is in the requested state; archived cards are deliberately
 * accepted here.
 */
export function archiveCard({ auth, card, ctx, archived }: {
  auth: AuthClaims;
  card: typeof cards.$inferSelect;
  ctx: CardAccessContext;
  archived: boolean;
}): Promise<CardArchiveTransition> {
  return archiveCards({ cardIds: [card.id], archived, workspaceId: ctx.workspaceId, clientId: ctx.clientId, actorId: auth.sub, bulk: false });
}

/** Post-commit fanout for `archiveCard`; returns the wire card the route responds with. */
export async function emitArchivedCard(
  result: CardArchiveTransition,
  { card, auth, mailer, log }: { card: typeof cards.$inferSelect; auth: AuthClaims; mailer: Mailer; log: { warn(obj: object, msg: string): void } },
) {
  const [wireCard] = await emitCardArchiveTransition(result, { clientId: auth.cid, mailer, log });
  if (wireCard) return wireCard;
  // A concurrent request changed the card first and emitted it; respond with the row as it now is.
  const [current] = await db.select().from(cards).where(eq(cards.id, card.id)).limit(1);
  return toWireCard(current ?? card, auth.cid);
}
