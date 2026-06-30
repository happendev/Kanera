import { defineConfig } from "drizzle-kit";
import "./src/load-env.js";

export default defineConfig({
  schema: "../../packages/shared/src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://kanera:kanera@localhost:5433/kanera",
  },
  strict: true,
  verbose: true,
});
