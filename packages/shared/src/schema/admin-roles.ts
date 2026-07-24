// Platform-staff roles for the admin console. Entirely separate from the tenant-scoped `client_role`:
// admins operate across all tenants, so this enum has nothing to do with org membership.
// `superadmin` manages other admins and performs destructive actions; `staff` is read + non-destructive
// mutations. Coarse on purpose; the value check makes future role changes ordinary transactional DDL.
export const ADMIN_ROLES = ["superadmin", "staff"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];
