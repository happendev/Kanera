/**
 * CSV column-mapping vocabularies shared by the DTO validation and the web wizard.
 *
 * Kept zod-free (like `name-limits.ts`) so the browser bundle can import the tuples without
 * pulling the validation runtime in with them.
 */
export const CSV_COLUMN_TARGETS = [
  "title", "description", "list", "labels", "assignees", "dueDate", "completed",
  "archived", "createdAt", "comment", "checklistItem", "customField", "cardId", "ignore",
] as const;
/** Targets that accept at most one column; `title` is additionally required exactly once. */
export const CSV_SINGLE_TARGETS = [
  "title", "description", "list", "dueDate", "completed", "archived", "createdAt", "cardId",
] as const;
export const CSV_MULTI_VALUE_DELIMITERS = [",", ";", "|", "newline"] as const;
export const CSV_DATE_ORDERS = ["auto", "dmy", "mdy"] as const;
