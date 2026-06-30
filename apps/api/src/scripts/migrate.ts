import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { z } from "zod";
import "../load-env.js";

const env = z
  .object({
    DATABASE_URL: z.url(),
    DATABASE_SSL: z
      .union([z.string(), z.boolean()])
      .transform((v) => v === true || v === "true")
      .default(false),
    PG_POOL_MAX: z.coerce.number().int().positive().default(10),
    PG_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),
    PG_CONNECTION_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(5_000),
    PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),
  })
  .parse(process.env);

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.PG_POOL_MAX,
  idleTimeoutMillis: env.PG_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.PG_CONNECTION_TIMEOUT_MS,
  statement_timeout: env.PG_STATEMENT_TIMEOUT_MS,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : false,
});

const db = drizzle(pool);

await migrate(db, { migrationsFolder: "./drizzle" });
await pool.end();
console.log("migrations applied");
