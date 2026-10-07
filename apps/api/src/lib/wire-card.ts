import { cardPath } from "@kanera/shared/card-links";
import type { WireCard } from "@kanera/shared/events";
import type { cards } from "@kanera/shared/schema";
import { env } from "../env.js";
import { signEmbeddedMediaUrls } from "./media-keys.js";

/** Absolute browser URL for a card, built from the immutable organisation key and the human card key. */
export function absoluteCardUrl(organisationKey: string, cardKey: string, webOrigin: string = env.WEB_ORIGIN): string {
  return new URL(cardPath(organisationKey, cardKey), webOrigin).toString();
}

/**
 * The card as clients see it: the per-client `clientToken` never leaves the server, inline media in
 * the description is signed for the reader's organisation, and the canonical URL is attached.
 */
export function toWireCard(card: typeof cards.$inferSelect, clientId: string): WireCard {
  const { clientToken: _clientToken, ...publicCard } = card;
  return {
    ...publicCard,
    description: signEmbeddedMediaUrls(card.description, clientId),
    url: absoluteCardUrl(card.organisationKey, card.key),
  };
}
