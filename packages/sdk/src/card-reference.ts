import type { KaneraHttpClient } from "./client.js";
import { KaneraApiError } from "./errors.js";
import type { Uuid } from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CARD_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$/iu;
const ORGANISATION_KEY_PATTERN = /^[A-F0-9]{16}$/iu;

export interface CanonicalCardReference {
  organisationKey: string;
  cardKey: string;
}

/** Parse a canonical Kanera card URL (`…/o/{organisationKey}/c/{CARD-KEY}`). */
export function parseCardUrl(value: string): CanonicalCardReference | null {
  if (!value.startsWith("/") && !/^https?:\/\//iu.test(value)) return null;
  try {
    const url = new URL(value, "https://kanera.invalid");
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    if (segments.length !== 4 || segments[0] !== "o" || segments[2] !== "c") return null;
    if (!ORGANISATION_KEY_PATTERN.test(segments[1]!) || !CARD_KEY_PATTERN.test(segments[3]!)) return null;
    return { organisationKey: segments[1]!.toUpperCase(), cardKey: segments[3]!.toUpperCase() };
  } catch {
    return null;
  }
}

/** True for a card UUID, a human key such as `MKT-42`, or a canonical card URL. */
export function isCardReference(value: string): boolean {
  const trimmed = value.trim();
  return UUID_PATTERN.test(trimmed) || CARD_KEY_PATTERN.test(trimmed) || parseCardUrl(trimmed) !== null;
}

async function resolveInOrganisation(http: KaneraHttpClient, reference: CanonicalCardReference): Promise<Uuid | null> {
  try {
    const card = await http.get<{ id: Uuid }>(
      `/api/v1/organisations/${encodeURIComponent(reference.organisationKey)}/cards/by-key/${encodeURIComponent(reference.cardKey)}`,
    );
    return card.id;
  } catch (error) {
    if (error instanceof KaneraApiError && error.isNotFound) return null;
    throw error;
  }
}

/**
 * Turn a card UUID, human key, or canonical URL into the UUID the API's card routes take.
 *
 * A key prefix is unique only within one organisation, and a personal credential can see several.
 * So a bare key is resolved by searching every accessible organisation for candidates, then asking
 * each candidate organisation to confirm an exact current-or-historical key match — search alone
 * would also return incidental title and content hits. An ambiguous key is rejected rather than
 * guessed at, because picking the wrong organisation's card is a tenancy error, not a near miss.
 */
export async function resolveCardReference(http: KaneraHttpClient, rawReference: string): Promise<Uuid> {
  const reference = rawReference.trim();
  if (UUID_PATTERN.test(reference)) return reference;

  const canonical = parseCardUrl(reference);
  if (canonical) {
    const id = await resolveInOrganisation(http, canonical);
    if (id) return id;
    throw new KaneraApiError(404, "NOT_FOUND", `card ${canonical.cardKey} was not found or is not accessible`);
  }
  if (!CARD_KEY_PATTERN.test(reference)) {
    throw new KaneraApiError(400, "VALIDATION_ERROR", "use a card UUID, a key such as MKT-42, or a canonical Kanera card URL");
  }

  const result = await http.get<{ cards: { cardId: Uuid; cardKey: string; organisationKey: string }[] }>(
    "/api/v1/search",
    { query: { q: reference, limit: 20 } },
  );
  const candidateIds = new Set<Uuid>();
  const currentMatches = result.cards.filter((card) => card.cardKey.toUpperCase() === reference.toUpperCase());
  for (const card of currentMatches) candidateIds.add(card.cardId);

  // A card renamed into a new prefix keeps its old key resolvable, but search indexes only the
  // current one — so organisations that surfaced for other reasons are still asked directly.
  const currentOrganisations = new Set(currentMatches.map((card) => card.organisationKey.toUpperCase()));
  const otherOrganisations = [...new Set(
    result.cards
      .map((card) => card.organisationKey.toUpperCase())
      .filter((organisationKey) => !currentOrganisations.has(organisationKey)),
  )];
  const historical = await Promise.all(otherOrganisations.map((organisationKey) =>
    resolveInOrganisation(http, { organisationKey, cardKey: reference.toUpperCase() })));
  for (const id of historical) if (id) candidateIds.add(id);

  if (candidateIds.size === 1) return candidateIds.values().next().value!;
  if (candidateIds.size > 1) {
    throw new KaneraApiError(
      400,
      "VALIDATION_ERROR",
      `card key ${reference.toUpperCase()} is ambiguous across accessible organisations; use a canonical card URL or UUID`,
    );
  }
  throw new KaneraApiError(404, "NOT_FOUND", `card ${reference.toUpperCase()} was not found or is not accessible`);
}

/**
 * Memoising resolver. Resolution costs a search round trip, and bulk operations routinely name the
 * same card more than once; the cache holds the promise so concurrent callers share one request.
 */
export function createCardReferenceResolver(http: KaneraHttpClient): (reference: string) => Promise<Uuid> {
  const cache = new Map<string, Promise<Uuid>>();
  return (reference) => {
    const normalized = reference.trim();
    const canonical = parseCardUrl(normalized);
    const cacheKey = canonical
      ? `${canonical.organisationKey}/${canonical.cardKey}`
      : CARD_KEY_PATTERN.test(normalized)
        ? normalized.toUpperCase()
        : normalized.toLowerCase();
    let pending = cache.get(cacheKey);
    if (!pending) {
      pending = resolveCardReference(http, normalized);
      cache.set(cacheKey, pending);
    }
    return pending;
  };
}
