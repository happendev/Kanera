/** Canonical browser path for a human-readable card key inside its immutable organisation namespace. */
export function cardPath(organisationKey: string, cardKey: string): string {
  // API payloads cross an untyped JSON boundary, so compile-time required fields are not enough to
  // prevent a missing namespace from silently becoming a plausible `/o/undefined/...` URL.
  if (!/^[A-F0-9]{16}$/iu.test(organisationKey)) throw new Error("invalid organisation route key");
  if (typeof cardKey !== "string" || !cardKey.trim()) throw new Error("invalid card key");
  return `/o/${encodeURIComponent(organisationKey)}/c/${encodeURIComponent(cardKey)}`;
}
