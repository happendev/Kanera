import { z } from "zod";

/**
 * An IANA time zone name, defaulting to UTC for callers that do not send one.
 *
 * Any query that buckets timestamps into calendar days needs this: a late-evening
 * update must land on the viewer's day, not the server's. Validated rather than
 * trusted because the value reaches Postgres inside `AT TIME ZONE`, where an
 * unknown zone is a runtime error rather than a rejected request.
 */
export const ianaTimeZone = z
  .string()
  .min(1)
  .max(100)
  .default("UTC")
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, "Invalid IANA time zone");
