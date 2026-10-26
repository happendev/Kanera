import { jsonb, pgTable, uuid } from "drizzle-orm/pg-core";
import { users } from "./user.js";

export interface SignupAcquisition {
  source: string;
  medium: string;
  campaign: string;
  content?: string;
  term?: string;
  landing_page?: string;
  referring_domain?: string;
  captured_at?: string;
  consented_at?: string;
  consent_version?: 1;
  fbclid?: string;
  gclid?: string;
  li_fat_id?: string;
  msclkid?: string;
}

// Separate from user/client rows so ordinary account DTOs, member listings and exports never
// accidentally expose advertising identifiers. The original signup is immutable and follows
// the user's deletion lifecycle; an invited member cannot replace an organisation's acquisition.
export const userAcquisitions = pgTable("user_acquisition", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  attribution: jsonb("attribution").$type<SignupAcquisition>().notNull(),
});
