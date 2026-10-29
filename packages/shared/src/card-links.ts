/** Canonical browser path for a human-readable card key inside its immutable organisation namespace. */
export function cardPath(organisationKey: string, cardKey: string): string {
  // API payloads cross an untyped JSON boundary, so compile-time required fields are not enough to
  // prevent a missing namespace from silently becoming a plausible `/o/undefined/...` URL.
  if (!/^[A-F0-9]{16}$/iu.test(organisationKey)) throw new Error("invalid organisation route key");
  if (typeof cardKey !== "string" || !cardKey.trim()) throw new Error("invalid card key");
  return `/o/${encodeURIComponent(organisationKey)}/c/${encodeURIComponent(cardKey)}`;
}

const BRANCH_SLUG_MAX = 40;

/**
 * Suggested git branch for a card, e.g. `kan-123-fix-login-redirect`. It starts with the card key
 * so GitHub pull requests from it link back to the card (see `cardKeysInPullRequest`). Titles with
 * no Latin letters or digits leave just the key.
 */
export function cardBranchName(cardKey: string, title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const trimmed = slug.length > BRANCH_SLUG_MAX ? slug.slice(0, BRANCH_SLUG_MAX).replace(/-[^-]*$/u, "") : slug;
  const key = cardKey.toLowerCase();
  return trimmed ? `${key}-${trimmed}` : key;
}

const MAX_PULL_REQUEST_CARD_KEYS = 20;
// Branch names are lowercased by convention (see cardBranchName), so they match in any case.
// Prose in a title or body only matches the canonical upper-case key, which keeps phrases such as
// "see-2" from being read as a card reference.
const BRANCH_CARD_KEY_RE = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-([1-9][0-9]{0,8})(?![0-9])/gu;
const TEXT_CARD_KEY_RE = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,9})-([1-9][0-9]{0,8})(?![0-9A-Za-z])/gu;

/** Card keys (upper case, unique, capped) a pull request names in its head branch, title or body. */
export function cardKeysInPullRequest(pull: { headRef: string; title: string; body: string | null }): string[] {
  const keys = new Set<string>();
  const collect = (text: string, pattern: RegExp) => {
    for (const match of text.matchAll(pattern)) {
      if (keys.size >= MAX_PULL_REQUEST_CARD_KEYS) return;
      keys.add(`${match[1]!.toUpperCase()}-${match[2]}`);
    }
  };
  collect(pull.headRef, BRANCH_CARD_KEY_RE);
  collect(pull.title, TEXT_CARD_KEY_RE);
  collect(pull.body ?? "", TEXT_CARD_KEY_RE);
  return [...keys];
}
