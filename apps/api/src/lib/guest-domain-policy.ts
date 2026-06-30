import { users } from "@kanera/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import { db, type Db } from "../db.js";
import { badRequest } from "./errors.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

export async function assertGuestEmailDoesNotMatchOwnerDomain(params: {
  hostClientId: string;
  email: string;
  targetClientId?: string;
  tx?: Tx;
}): Promise<void> {
  if (params.targetClientId === params.hostClientId) return;
  const domain = emailDomain(params.email);
  if (!domain) return;

  const database = params.tx ?? db;
  const ownerRows = await database
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.clientId, params.hostClientId), eq(users.clientRole, "owner"), isNull(users.suspendedAt), isNull(users.removedAt)));

  const ownerDomains = new Set(ownerRows.map((row) => emailDomain(row.email)).filter((value): value is string => !!value));
  if (!ownerDomains.has(domain)) return;

  throw badRequest("Guests cannot use this organisation's owner email domain. Invite this person as an organisation member instead.");
}
