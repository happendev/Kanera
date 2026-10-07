import { comments, users } from "@kanera/shared/schema";
import { sql } from "drizzle-orm";

/**
 * How a comment's author is presented. System comments read as "Kanera", API-key comments carry the
 * key's name, and only human authors expose their avatar. Select from `comments` joined to `users`.
 */
export const commentAuthorColumns = {
  authorName: sql<string>`case when ${comments.authorKind} = 'system' then 'Kanera' when ${comments.authorKind} = 'apiKey' then coalesce(${comments.apiKeyName}, 'API key') else ${users.displayName} end`,
  authorAvatarUrl: sql<string | null>`case when ${comments.authorKind} in ('system', 'apiKey') then null else ${users.avatarUrl} end`,
} as const;
