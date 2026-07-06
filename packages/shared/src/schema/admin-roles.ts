import { pgEnum } from "drizzle-orm/pg-core";

// Platform-staff roles for the admin console. Entirely separate from the tenant-scoped `client_role`:
// admins operate across all tenants, so this enum has nothing to do with org membership.
// `superadmin` manages other admins and performs destructive actions; `staff` is read + non-destructive
// mutations. Coarse on purpose — the enum lets us add finer capabilities later without a migration.
export const adminRole = pgEnum("admin_role", ["superadmin", "staff"]);
export type AdminRole = (typeof adminRole.enumValues)[number];
