import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

type CheckValue = string | number;

/**
 * Builds an inline, safely escaped IN expression for schema-level CHECK constraints.
 * Drizzle's text enum metadata only narrows TypeScript types; this helper is the
 * database-enforced half of the same application-owned value contract.
 */
export function valueIn(column: SQLWrapper, values: readonly CheckValue[]): SQL {
  if (values.length === 0) throw new Error("valueIn requires at least one allowed value");

  const allowed = sql.join(values.map((value) => sql`${value}`), sql`, `);
  return sql`${column} in (${allowed})`.inlineParams();
}

/** Ensures every member of a PostgreSQL text array belongs to the allowed set. */
export function textArrayValuesIn(column: SQLWrapper, values: readonly string[]): SQL {
  if (values.length === 0) throw new Error("textArrayValuesIn requires at least one allowed value");

  const allowed = sql.join(values.map((value) => sql`${value}`), sql`, `);
  return sql`${column} <@ array[${allowed}]::text[]`.inlineParams();
}
