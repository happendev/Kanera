import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { cards } from "./card.js";
import { clients } from "./client.js";

/** Kanera's reading of a pull request: GitHub's open/closed plus its draft flag and merge time. */
export const CARD_GITHUB_PULL_STATES = ["draft", "open", "merged", "closed"] as const;
export type CardGitHubPullState = (typeof CARD_GITHUB_PULL_STATES)[number];

/**
 * A GitHub pull request that named a card by its key (in its branch, title or body), recorded from
 * the GitHub App's `pull_request` webhooks.
 *
 * Deliberately not stored in `external_link`: its unique index allows one entity per external id,
 * but one pull request can close several cards. A link is never removed when the key later
 * disappears from the pull request, so a card keeps the history of the work that referenced it.
 *
 * `clientId` is the organisation whose installation delivered the webhook. A card key only
 * resolves inside that organisation, so a link never crosses tenancy.
 */
export const cardGitHubPulls = pgTable(
  "card_github_pull",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    repoFullName: text("repo_full_name").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    headRef: text("head_ref").notNull(),
    state: text("state", { enum: CARD_GITHUB_PULL_STATES }).notNull(),
    additions: integer("additions"),
    deletions: integer("deletions"),
    // GitHub's own `updated_at` for the pull request. Webhooks can arrive out of order, so an
    // older snapshot never overwrites a newer one.
    githubUpdatedAt: timestamp("github_updated_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("card_github_pulls_state_ck", valueIn(t.state, CARD_GITHUB_PULL_STATES)),
    uniqueIndex("card_github_pulls_card_repo_number_uq").on(t.cardId, t.repoFullName, t.number),
    // A webhook updates every card the pull request is already linked to, even after its key
    // was edited out of the title.
    index("card_github_pulls_client_repo_number_idx").on(t.clientId, t.repoFullName, t.number),
  ],
);

export type CardGitHubPull = typeof cardGitHubPulls.$inferSelect;
