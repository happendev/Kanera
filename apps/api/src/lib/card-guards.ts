import type { cards } from "@kanera/shared/schema";
import { badRequest } from "./errors.js";
import { externalEmbeddedMediaReferences } from "./media-keys.js";

export function assertCardActive(card: Pick<typeof cards.$inferSelect, "archivedAt">) {
  if (card.archivedAt) throw badRequest("archived cards are read-only");
}

/**
 * Integrations (API keys) may only embed media that already lives in Kanera storage: a hot-linked
 * external image would be fetched by every reader's browser and could leak their presence.
 */
export function assertIntegrationEmbeddedMediaStoredLocally(markdown: string | null | undefined, clientId: string, authKind?: string) {
  if (authKind !== "apiKey") return;
  const externalRefs = externalEmbeddedMediaReferences(markdown, clientId);
  if (externalRefs.length > 0) {
    throw badRequest("inline media from integrations must be uploaded to Kanera before embedding");
  }
}
