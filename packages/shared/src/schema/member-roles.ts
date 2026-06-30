import { pgEnum } from "drizzle-orm/pg-core";

export const memberRole = pgEnum("member_role", ["owner", "admin", "editor", "observer"]);
export type MemberRole = (typeof memberRole.enumValues)[number];
