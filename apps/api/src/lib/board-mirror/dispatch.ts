import type { BoardMirrorFacet, EventOutbox } from "@kanera/shared/schema";

export interface MirrorDirtySignal {
  sourceCardId: string;
  facets: BoardMirrorFacet[];
}

function payloadCardId(event: EventOutbox): string | null {
  const payload = event.payload as Record<string, unknown>;
  if (event.eventType === "card:created" || event.eventType === "card:updated") {
    const card = payload.card as Record<string, unknown> | undefined;
    return typeof card?.id === "string" ? card.id : null;
  }
  return typeof payload.cardId === "string" ? payload.cardId : null;
}

/** Outbox rows are dirty signals: the worker re-reads current state instead of replaying diffs. */
export function dispatchMirrorEvent(event: EventOutbox): MirrorDirtySignal | null {
  const sourceCardId = payloadCardId(event);
  if (!sourceCardId) return null;

  switch (event.eventType) {
    case "card:created": return { sourceCardId, facets: ["link", "activities"] };
    case "card:moved": return { sourceCardId, facets: ["link", "core", "activities"] };
    case "card:updated":
    case "card:deleted": return { sourceCardId, facets: ["core", "activities"] };
    case "card:labels:set": return { sourceCardId, facets: ["labels", "activities"] };
    case "card:customFieldValue:set":
    case "card:customFieldValue:cleared": return { sourceCardId, facets: ["fields", "activities"] };
    case "comment:created":
    case "comment:updated":
    case "comment:deleted": return { sourceCardId, facets: ["comments", "activities"] };
    case "card:attachment:created":
    case "card:attachment:deleted": return { sourceCardId, facets: ["attachments", "activities"] };
    case "card:checklist:created":
    case "card:checklist:updated":
    case "card:checklist:moved":
    case "card:checklist:rebalanced":
    case "card:checklist:deleted":
    case "card:checklistItem:created":
    case "card:checklistItem:updated":
    case "card:checklistItem:moved":
    case "card:checklistItem:rebalanced":
    case "card:checklistItem:deleted": return { sourceCardId, facets: ["checklists", "activities"] };
    // Feed rows are mutable current-state records. Content signals also include this facet so an
    // activity that arrives before its attachment/comment/checklist mapping is retried after that
    // entity is converged, rather than permanently retaining a source identifier.
    case "card:feedItem:created":
    case "card:feedItem:updated":
    case "card:feedItem:deleted": return { sourceCardId, facets: ["activities"] };
    default: return null;
  }
}
