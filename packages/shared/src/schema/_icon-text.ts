import { customType } from "drizzle-orm/pg-core";

/**
 * Icon slugs become CSS class tokens in every client. New writes use the shared
 * icon catalogue, but older importers could store arbitrary text. Constrain
 * those existing values when decoding any column projection, including aliased
 * joins, without rewriting stored data or changing the PostgreSQL text type.
 * Drizzle preserves SQL NULL before calling this decoder.
 */
export function iconText(name: string, fallback: string) {
  return customType<{ data: string; driverData: string }>({
    dataType: () => "text",
    fromDriver: (value) => /^[a-z0-9-]{1,60}$/.test(value) ? value : fallback,
  })(name);
}
