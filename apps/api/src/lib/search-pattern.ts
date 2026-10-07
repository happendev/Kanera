/**
 * Case-folded ILIKE pattern for a free-text query. Escapes the LIKE metacharacters so a user typing
 * `%` or `_` searches for those characters instead of widening the match.
 */
export function escapedSearchPattern(query: string): string {
  return `%${query.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
}
