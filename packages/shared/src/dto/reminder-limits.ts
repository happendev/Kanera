/**
 * Furthest ahead a card reminder may be scheduled: eight weeks. A reminder is a nudge about work in
 * flight, not a calendar; anything further out belongs in a due date. Dependency-free so the web
 * picker can bound its calendar without pulling the DTO barrel (and its schema imports) into the bundle.
 */
export const MAX_REMINDER_LEAD_DAYS = 8 * 7;
