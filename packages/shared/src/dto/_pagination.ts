import { z } from "zod";

/**
 * Offset paging for directory-style endpoints that sit behind an opaque MCP cursor. `limit` stays
 * optional so the first-party app routes keep returning their existing complete lists; `limit` is
 * one above the page size so the server can detect "has more" without a count query.
 */
export const offsetPagedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(101).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
