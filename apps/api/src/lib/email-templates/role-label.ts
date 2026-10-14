import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../i18n/messages/index.js";
import type { Role } from "../i18n/messages/types.js";

/** A stored organisation or board role as the recipient reads it; unknown roles are capitalised. */
export function roleLabel(role: string, locale: Locale): string {
  const roles = serverMessages(locale).common.roles;
  return Object.hasOwn(roles, role) ? roles[role as Role] : role.charAt(0).toUpperCase() + role.slice(1);
}
