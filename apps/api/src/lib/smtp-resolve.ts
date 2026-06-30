import type { SmtpConfig } from "@kanera/shared/schema";
import { clients } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { smtpConfigFromEnv } from "./smtp.js";

/**
 * Resolve the effective SMTP config for sending email on behalf of a client.
 * Priority: client-level DB config > env-level config > null.
 *
 * Pass "__env__" as clientId to skip the DB lookup and use env config directly.
 */
export async function resolveSmtpConfig(clientId: string): Promise<SmtpConfig | null> {
  if (clientId === "__env__") return smtpConfigFromEnv();

  const [row] = await db
    .select({ smtpConfig: clients.smtpConfig })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);

  return row?.smtpConfig ?? smtpConfigFromEnv();
}
