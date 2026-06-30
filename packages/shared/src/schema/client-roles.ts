import { pgEnum } from "drizzle-orm/pg-core";

export const clientRole = pgEnum("client_role", ["owner", "admin", "member"]);
export type ClientRole = (typeof clientRole.enumValues)[number];
