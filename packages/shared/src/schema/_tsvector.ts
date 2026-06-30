import { customType } from "drizzle-orm/pg-core";

// Postgres `tsvector` column type for full-text search. Internal to the schema
// package — used only for generated `search_vector` columns backing global search.
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});
