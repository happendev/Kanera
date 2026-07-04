import { z } from "zod";
import { GENERAL_NAME_MAX_LENGTH } from "./name-limits.js";
import type { Entitlements } from "./clients.js";

// Plan/billing enums mirror the Drizzle pgEnums on `clients` (client.ts). Kept as literal zod enums here
// so the shared DTO package does not depend on the server-only schema module.
export const adminClientPlanEnum = z.enum(["free", "paid"]);
export const adminBillingStatusEnum = z.enum(["none", "trialing", "active", "past_due", "canceled"]);
export const adminBillingIntervalEnum = z.enum(["monthly", "annual"]);

const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().pipe(z.union([z.literal(25), z.literal(50), z.literal(100)])).default(25),
};
const direction = z.enum(["asc", "desc"]).default("desc");

// --- Auth ---
export const adminLoginBody = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export type AdminLoginBody = z.infer<typeof adminLoginBody>;

export const adminCreateInviteBody = z.object({
  email: z.email(),
  displayName: z.string().trim().min(1).max(GENERAL_NAME_MAX_LENGTH),
});
export type AdminCreateInviteBody = z.infer<typeof adminCreateInviteBody>;

export const adminAcceptInviteBody = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(256),
});
export type AdminAcceptInviteBody = z.infer<typeof adminAcceptInviteBody>;

export const adminInviteTokenQuery = z.object({ token: z.string().min(1) });

// --- Orgs ---
export const adminListOrgsQuery = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  plan: adminClientPlanEnum.optional(),
  billingStatus: adminBillingStatusEnum.optional(),
  sort: z.enum(["name", "plan", "billingStatus", "memberCount", "createdAt", "status"]).default("createdAt"),
  direction,
  ...pageQuery,
});
export type AdminListOrgsQuery = z.infer<typeof adminListOrgsQuery>;

export const adminUpdateOrgPlanBody = z
  .object({
    plan: adminClientPlanEnum.optional(),
    billingStatus: adminBillingStatusEnum.optional(),
    // Nullable: clearing the interval is a valid state (e.g. moving back to free with no subscription).
    billingInterval: adminBillingIntervalEnum.nullable().optional(),
    storageQuotaBytes: z.number().int().nonnegative().nullable().optional(),
    currentPeriodEnd: z.coerce.date().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "no fields to update" });
export type AdminUpdateOrgPlanBody = z.infer<typeof adminUpdateOrgPlanBody>;

export const adminUpdateOrgSettingsBody = z
  .object({
    name: z.string().trim().min(1).max(GENERAL_NAME_MAX_LENGTH).optional(),
    // Nullable so an admin can clear a bad/broken logo. Storage/SMTP secrets are intentionally NOT
    // exposed here — the admin console never surfaces tenant integration credentials.
    logoUrl: z.string().max(2048).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "no fields to update" });
export type AdminUpdateOrgSettingsBody = z.infer<typeof adminUpdateOrgSettingsBody>;

// --- Users ---
export const adminListUsersQuery = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  clientId: z.uuid().optional(),
  suspended: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  sort: z.enum(["displayName", "email", "orgName", "role", "createdAt", "lastOnlineAt", "status"]).default("createdAt"),
  direction,
  ...pageQuery,
});
export type AdminListUsersQuery = z.infer<typeof adminListUsersQuery>;

export const adminListAdminsQuery = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  sort: z.enum(["displayName", "email", "status", "createdAt", "lastActivityAt"]).default("createdAt"),
  direction,
  ...pageQuery,
});

export const adminListOrgPeopleQuery = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  sort: z.enum(["displayName", "email", "kind", "access", "lastOnlineAt"]).default("displayName"),
  direction: z.enum(["asc", "desc"]).default("asc"),
  ...pageQuery,
});

export const adminUpdateUserRoleBody = z.object({
  role: z.enum(["owner", "admin", "member"]),
});
export type AdminUpdateUserRoleBody = z.infer<typeof adminUpdateUserRoleBody>;

// --- Ops queues ---
// One shared filter for all three queues. `status` is validated per-queue in the route since each queue
// has its own status vocabulary (numeric email status vs. webhook enum vs. outbox boolean flags).
export const adminQueueFilterQuery = z.object({
  status: z.string().trim().min(1).max(40).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  sort: z.enum(["primary", "status", "attempts", "lastError", "createdAt"]).default("createdAt"),
  direction,
  ...pageQuery,
});
export type AdminQueueFilterQuery = z.infer<typeof adminQueueFilterQuery>;

export const adminHealthQuery = z.object({
  days: z.coerce.number().pipe(z.union([z.literal(30), z.literal(60), z.literal(90)])).default(30),
});
export type AdminHealthQuery = z.infer<typeof adminHealthQuery>;

// --- Response shapes ---
export interface AdminOrgListItem {
  id: string;
  name: string;
  logoUrl: string | null;
  plan: string;
  billingStatus: string;
  billingInterval: string | null;
  memberCount: number;
  suspendedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export interface AdminOrgDetail extends AdminOrgListItem {
  deploymentMode: "self_hosted" | "hosted";
  storageQuotaBytes: number | null;
  currentPeriodEnd: string | null;
  usage: {
    storageUsedBytes: number;
    storageQuotaBytes: number | null;
    workspaceCount: number;
    boardCount: number;
    cardCount: number;
    memberCount: number;
    guestCount: number;
  };
  entitlements: Entitlements;
}

export interface AdminOrgPersonListItem {
  id: string;
  displayName: string;
  email: string;
  kind: "user" | "guest";
  role: string | null;
  boardCount: number | null;
  lastOnlineAt: string | null;
}

export interface AdminUserListItem {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  clientId: string;
  orgName: string;
  role: string;
  suspendedAt: string | null;
  removedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  lastOnlineAt: string | null;
}

export interface AdminAccountListItem {
  id: string;
  kind: "account" | "invite";
  email: string;
  displayName: string;
  status: "active" | "disabled" | "pending";
  createdAt: string;
  lastLoginAt: string | null;
  expiresAt: string | null;
}

export interface AdminUserDetail extends AdminUserListItem {
  emailVerifiedAt: string | null;
  memberships: { workspaceId: string; workspaceName: string; role: string }[];
  guestBoardAccess: {
    boardId: string;
    boardName: string;
    workspaceId: string;
    workspaceName: string;
    clientId: string;
    orgName: string;
    role: string;
    addedAt: string;
  }[];
}

// --- Support sessions ---
// Started only from the portal (superadmin role). Always acts as the target org's owner, so the request
// carries just a justification; the org is taken from the route (:clientId).
export const adminStartSupportSessionBody = z.object({
  // Required, human-readable justification. Persisted verbatim in the support_session audit row.
  reason: z.string().trim().min(5).max(500),
});
export type AdminStartSupportSessionBody = z.infer<typeof adminStartSupportSessionBody>;

export const adminSupportSessionResponse = z.object({
  // WEB_ORIGIN/support/enter#token=… — the token lives in the fragment so it never reaches the server.
  url: z.url(),
  expiresAt: z.string(),
  session: z.object({
    id: z.uuid(),
    targetClientId: z.uuid(),
    targetUserId: z.uuid(),
    orgName: z.string(),
  }),
  // Email of the owner the session acts as, surfaced so the operator can confirm who they entered as.
  actingAsEmail: z.string(),
});
export type AdminSupportSessionResponse = z.infer<typeof adminSupportSessionResponse>;

export const adminListSupportSessionsQuery = z.object({
  // Optional filter to one org (used by the org detail panel).
  clientId: z.uuid().optional(),
  // "active" = not ended and not yet expired; used to surface live impersonations for quick revocation.
  status: z.enum(["active", "all"]).default("all"),
  sort: z.enum(["createdAt", "expiresAt"]).default("createdAt"),
  direction,
  ...pageQuery,
});
export type AdminListSupportSessionsQuery = z.infer<typeof adminListSupportSessionsQuery>;

export interface AdminSupportSessionListItem {
  id: string;
  adminEmail: string;
  targetClientId: string | null;
  targetOrgName: string;
  targetUserEmail: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
  // Convenience flag: not ended and not yet expired at read time.
  active: boolean;
}
