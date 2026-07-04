import { adminUsers } from "@kanera/shared/schema";
import { sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../db.js";
import { env } from "../env.js";
import { hashPassword } from "../auth/password.js";

// Seeds the first superadmin from ADMIN_EMAIL/ADMIN_PASSWORD when the admin_users table is empty. Only
// ever runs on a fresh install: once any admin exists, this is a no-op regardless of the env values, so
// leaving the credentials in the environment does not reset or duplicate the account.
export async function seedFirstAdmin(log: FastifyBaseLogger): Promise<void> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(adminUsers);

  if ((row?.count ?? 0) > 0) return;

  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    // A fresh deploy with no admins and no seed credentials has no way in — warn loudly rather
    // than boot a locked-out console silently.
    log.warn("no admin users exist and ADMIN_EMAIL/ADMIN_PASSWORD are not set; the admin console has no accounts");
    return;
  }

  const passwordHash = await hashPassword(env.ADMIN_PASSWORD);
  await db.insert(adminUsers).values({
    email: env.ADMIN_EMAIL,
    passwordHash,
    displayName: "Platform Admin",
    role: "superadmin",
  });
  log.info({ email: env.ADMIN_EMAIL }, "seeded first platform superadmin");
}
