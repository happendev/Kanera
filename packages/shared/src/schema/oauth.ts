import { sql } from "drizzle-orm";
import { index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./user.js";
import { workspaceApiKeys } from "./workspace-api-key.js";
import { workspaces } from "./workspace.js";

export const oauthClientKind = pgEnum("oauth_client_kind", ["public", "service"]);
export const oauthTokenKind = pgEnum("oauth_token_kind", ["access", "refresh"]);

export const oauthClients = pgTable("oauth_client", {
  clientId: text("client_id").primaryKey(),
  kind: oauthClientKind("kind").notNull(),
  name: text("name").notNull(),
  clientSecretHash: text("client_secret_hash"),
  redirectUris: text("redirect_uris").array().notNull().default(sql`'{}'::text[]`),
  grantTypes: text("grant_types").array().notNull(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
  apiKeyId: uuid("api_key_id").references(() => workspaceApiKeys.id, { onDelete: "cascade" }),
  createdById: uuid("created_by_id").references(() => users.id, { onDelete: "cascade" }),
  maxScope: text("max_scope"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("oauth_clients_workspace_idx").on(t.workspaceId, t.createdAt),
  index("oauth_clients_creator_idx").on(t.createdById, t.createdAt),
]);

export const oauthGrants = pgTable("oauth_grant", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  clientId: text("client_id").notNull().references(() => oauthClients.clientId, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  scopes: text("scopes").array().notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("oauth_grants_user_idx").on(t.userId, t.createdAt),
  index("oauth_grants_client_idx").on(t.clientId, t.createdAt),
]);

export const oauthAuthorizationCodes = pgTable("oauth_authorization_code", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  codeHash: text("code_hash").notNull().unique(),
  clientId: text("client_id").notNull().references(() => oauthClients.clientId, { onDelete: "cascade" }),
  grantId: uuid("grant_id").notNull().references(() => oauthGrants.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  scopes: text("scopes").array().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("oauth_codes_client_idx").on(t.clientId, t.createdAt)]);

export const oauthTokens = pgTable("oauth_token", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  kind: oauthTokenKind("kind").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  clientId: text("client_id").notNull().references(() => oauthClients.clientId, { onDelete: "cascade" }),
  grantId: uuid("grant_id").references(() => oauthGrants.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  apiKeyId: uuid("api_key_id").references(() => workspaceApiKeys.id, { onDelete: "cascade" }),
  familyId: uuid("family_id").notNull(),
  scopes: text("scopes").array().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("oauth_tokens_family_idx").on(t.familyId),
  index("oauth_tokens_user_idx").on(t.userId, t.createdAt),
  index("oauth_tokens_api_key_idx").on(t.apiKeyId, t.createdAt),
]);

export type OauthClient = typeof oauthClients.$inferSelect;
