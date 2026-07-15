import { sql } from "drizzle-orm";
import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { clients } from "./client.js";

export type GitHubInstalledRepository = {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
};

/**
 * Deployment-level GitHub App credentials. There is at most one row for the whole
 * deployment, used only when the `GITHUB_APP_*` env vars are not set (self-host
 * bootstrap via the manifest flow). Env credentials always take precedence.
 *
 * The `singleton` column is constant `true` with a unique index, which restricts the
 * table to a single row.
 */
export const githubApp = pgTable(
  "github_app",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    singleton: boolean("singleton").notNull().default(true),
    encryptedAppId: text("encrypted_app_id").notNull(),
    appSlug: text("app_slug").notNull(),
    encryptedPrivateKey: text("encrypted_private_key").notNull(),
    encryptedWebhookSecret: text("encrypted_webhook_secret"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("github_app_singleton_uq").on(t.singleton)],
);

export type GitHubApp = typeof githubApp.$inferSelect;
export type NewGitHubApp = typeof githubApp.$inferInsert;

/**
 * Per-organisation installation of the deployment's GitHub App. Stores only the
 * installation id (not a secret) plus the account and the repositories it covers.
 */
export const githubAppInstallations = pgTable(
  "github_app_installation",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    repositorySelection: text("repository_selection").notNull(),
    repositories: jsonb("repositories").$type<GitHubInstalledRepository[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("github_app_installation_client_uq").on(t.clientId)],
);

export type GitHubAppInstallation = typeof githubAppInstallations.$inferSelect;
export type NewGitHubAppInstallation = typeof githubAppInstallations.$inferInsert;
