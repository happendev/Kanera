// Zod-free so the web app can import these without pulling the DTO schemas into its bundle.

/** Owners and admins are emailed once when hosted usage reaches this share of the quota. */
export const STORAGE_WARNING_PERCENT = 80;

/** Most files one storage cleanup request may delete. */
export const STORAGE_DELETE_MAX_FILES = 100;
