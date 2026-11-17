import { isoTimestamp } from "./_dates.js";
import { z } from "zod";
import { ACCENTS, THEMES } from "../appearance.js";
import { LOCALES } from "../locales.js";
import { CLIENT_ROLES } from "../schema/client-roles.js";
import { CLIENT_BILLING_STATUSES, CLIENT_PLANS } from "../schema/client.js";
import { SIGN_IN_PROVIDERS } from "../schema/user-identity.js";
import { GENERAL_NAME_MAX_LENGTH } from "./name-limits.js";
import { deploymentModeSchema, kaneraEnvironmentSchema } from "./deployment.js";

// Why the API answered 401 UNAUTHORIZED, sent as `reason` beside `code` on the error body. Expired
// access tokens are the routine trigger for a client's refresh-and-retry; the other reasons are
// genuine authentication failures, so clients, logs and metrics can tell the two apart.
export const AUTH_FAILURE_REASONS = ["token_expired", "no_token", "token_invalid"] as const;
export type AuthFailureReason = (typeof AUTH_FAILURE_REASONS)[number];

export const storageUsageResponse = z.object({
  usedBytes: z.number().int().nonnegative(),
  quotaBytes: z.number().int().nonnegative().nullable(),
  remainingBytes: z.number().int().nonnegative().nullable(),
  limited: z.boolean(),
  maxFileBytes: z.number().int().positive(),
});
export type StorageUsageResponse = z.infer<typeof storageUsageResponse>;

// 6-digit email verification code shared by signup and email-change confirmation.
const verificationCode = z.string().regex(/^\d{6}$/);

const analyticsAttribution = z.object({
  source: z.string().trim().min(1).max(120),
  medium: z.string().trim().min(1).max(120),
  campaign: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(120).optional(),
  term: z.string().trim().min(1).max(120).optional(),
  landing_page: z.string().max(256).regex(/^\/[^?#]*$/).optional(),
  referring_domain: z.string().max(253).regex(/^[a-zA-Z0-9.-]+$/).optional(),
  captured_at: isoTimestamp.optional(),
  consented_at: isoTimestamp.optional(),
  consent_version: z.literal(1).optional(),
  fbclid: z.string().trim().min(1).max(1024).optional(),
  gclid: z.string().trim().min(1).max(1024).optional(),
  li_fat_id: z.string().trim().min(1).max(1024).optional(),
  msclkid: z.string().trim().min(1).max(1024).optional(),
});

export const signupBody = z.object({
  orgName: z.string().min(1).max(GENERAL_NAME_MAX_LENGTH).default("Private"),
  email: z.email().max(254),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(GENERAL_NAME_MAX_LENGTH),
  inviteToken: z.string().min(1).optional(),
  boardInviteToken: z.string().min(1).optional(),
  // The language the signup form was shown in, stored so the first emails already arrive in it.
  locale: z.enum(LOCALES).optional(),
  // Consent-stamped first-touch attribution is stored privately, outside public account DTOs.
  // Legacy callers may still send the original three fields without requesting persistence.
  analyticsAttribution: analyticsAttribution.optional(),
  // Optional at the contract level so tests and self-hosted installs
  // configured keep working; the API requires it when Turnstile is enabled.
  turnstileToken: z.string().min(1).max(4096).optional(),
  // Optional at the contract level so the field is harmless when verification is
  // disabled (e.g. tests); the signup route requires and verifies it when the
  // EMAIL_VERIFICATION_ENABLED flag is on.
  code: verificationCode.optional(),
});
export type SignupBody = z.infer<typeof signupBody>;

export const requestEmailVerificationBody = z.object({
  email: z.email().max(254),
  // No account exists yet, so the code email is written in the language the form is showing.
  locale: z.enum(LOCALES).optional(),
  turnstileToken: z.string().min(1).max(4096).optional(),
  inviteToken: z.string().min(1).optional(),
  boardInviteToken: z.string().min(1).optional(),
});
export type RequestEmailVerificationBody = z.infer<typeof requestEmailVerificationBody>;

export const requestEmailChangeBody = z.object({
  email: z.email().max(254),
});
export type RequestEmailChangeBody = z.infer<typeof requestEmailChangeBody>;

export const confirmEmailChangeBody = z.object({
  email: z.email().max(254),
  code: verificationCode.optional(),
});
export type ConfirmEmailChangeBody = z.infer<typeof confirmEmailChangeBody>;

export const authConfigResponse = z.object({
  emailVerificationEnabled: z.boolean(),
  signupsEnabled: z.boolean(),
  turnstileSiteKey: z.string().nullable(),
  kaneraEnvironment: kaneraEnvironmentSchema,
  deploymentMode: deploymentModeSchema,
  // Hosted-only third-party sign-in providers this deployment offers; always empty when self-hosted.
  signInProviders: z.array(z.enum(SIGN_IN_PROVIDERS)),
  analytics: z.object({
    enabled: z.literal(true),
    provider: z.literal("posthog"),
    projectKey: z.string().min(1),
    apiHost: z.url(),
  }).nullable(),
});
export type AuthConfigResponse = z.infer<typeof authConfigResponse>;

export const loginBody = z.object({
  email: z.email().max(254),
  password: z.string().min(1),
});
export type LoginBody = z.infer<typeof loginBody>;

export const refreshBody = z.object({ clientId: z.uuid().optional() });
export type RefreshBody = z.infer<typeof refreshBody>;

export const switchOrgBody = z.object({ clientId: z.uuid() });
export type SwitchOrgBody = z.infer<typeof switchOrgBody>;

export const mfaCode = z.string().trim().min(6).max(32);
export const mfaChallengeBody = z.object({ challengeToken: z.string().min(1), code: mfaCode });
// `code` is required only when the caller already has an enabled factor (replacing it).
// Password-gated settings re-confirm the account owner with the current password. Accounts that sign
// in only through a provider have none, so they send `emailCode` from POST /auth/me/step-up-code.
// The API requires whichever one the account can produce.
const stepUp = {
  currentPassword: z.string().min(1).optional(),
  emailCode: verificationCode.optional(),
};
export const mfaEnrollmentStartBody = z.object({ ...stepUp, code: mfaCode.optional() });
export const mfaEnrollmentConfirmBody = z.object({ code: mfaCode });
export const mfaProtectedActionBody = z.object({ ...stepUp, code: mfaCode });
export type MfaChallengeBody = z.infer<typeof mfaChallengeBody>;
export type MfaProtectedActionBody = z.infer<typeof mfaProtectedActionBody>;

export const authOrganisation = z.object({
  clientId: z.uuid(),
  name: z.string(),
  logoUrl: z.string().nullable(),
  role: z.enum(CLIENT_ROLES),
  plan: z.enum(CLIENT_PLANS),
  billingStatus: z.enum(CLIENT_BILLING_STATUSES),
  hasWorkspace: z.boolean(),
  isHome: z.boolean(),
  unreadCount: z.number().int().nonnegative(),
});
export type AuthOrganisation = z.infer<typeof authOrganisation>;

export const authResponse = z.object({
  accessToken: z.string(),
  user: z.object({
    id: z.uuid(),
    clientId: z.uuid(),
    activeClientId: z.uuid(),
    email: z.email(),
    displayName: z.string(),
    avatarUrl: z.string().nullable(),
    timezone: z.string(),
    showCardKeys: z.boolean(),
    showScratchpad: z.boolean(),
    // Null until the account has actually chosen one; the client then keeps its device/OS default.
    theme: z.enum(THEMES).nullable(),
    accent: z.enum(ACCENTS).nullable(),
    // Null on legacy accounts that never chose; the client then follows the browser language.
    locale: z.enum(LOCALES).nullable(),
    orgName: z.string(),
    logoUrl: z.string().nullable(),
    deploymentMode: deploymentModeSchema,
    kaneraEnvironment: kaneraEnvironmentSchema,
    hasWorkspace: z.boolean(),
    inProgressEnabled: z.boolean(),
    role: z.enum(CLIENT_ROLES),
    isClientAdmin: z.boolean().optional(),
    organisations: z.array(authOrganisation),
    canCreateOrganisation: z.boolean(),
    storageUsage: storageUsageResponse,
    analyticsExcluded: z.boolean(),
    boardInviteRedirect: z.string().nullable().optional(),
  }),
});
export type AuthResponse = z.infer<typeof authResponse>;

export const forgotPasswordBody = z.object({
  email: z.email().max(254),
  // Optional at the contract level so self-hosted installs keep working; the API
  // requires it for hosted deployments with Turnstile configured.
  turnstileToken: z.string().min(1).max(4096).optional(),
});
export type ForgotPasswordBody = z.infer<typeof forgotPasswordBody>;

export const resetPasswordBody = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(200),
});
export type ResetPasswordBody = z.infer<typeof resetPasswordBody>;

// Email is intentionally absent: changing it goes through POST /auth/me/email,
// with a verification code required only when the deployment enables it.
export const updateMeBody = z.object({
  displayName: z.string().min(1).max(GENERAL_NAME_MAX_LENGTH).optional(),
  timezone: z.string().min(1).max(100).optional(),
  showCardKeys: z.boolean().optional(),
  showScratchpad: z.boolean().optional(),
  theme: z.enum(THEMES).optional(),
  accent: z.enum(ACCENTS).optional(),
  locale: z.enum(LOCALES).optional(),
});
export type UpdateMeBody = z.infer<typeof updateMeBody>;

// Without a stored password this sets the first one, confirmed by `emailCode` instead.
export const changePasswordBody = z.object({
  ...stepUp,
  newPassword: z.string().min(8).max(200),
});
export type ChangePasswordBody = z.infer<typeof changePasswordBody>;

export const signInProviderSchema = z.enum(SIGN_IN_PROVIDERS);
export const signInProviderParams = z.object({ provider: signInProviderSchema });

// Same-origin path only: a provider round-trip must never become an open redirect.
const returnPath = z.string().max(2048).regex(/^\/(?![/\\])/);

export const providerSignInBeginBody = z.object({
  returnUrl: returnPath.optional(),
  inviteToken: z.string().min(1).max(512).optional(),
  boardInviteToken: z.string().min(1).max(512).optional(),
  locale: z.enum(LOCALES).optional(),
  analyticsAttribution: analyticsAttribution.optional(),
});
export type ProviderSignInBeginBody = z.infer<typeof providerSignInBeginBody>;

export const providerBeginResponse = z.object({ authorizeUrl: z.url() });
export type ProviderBeginResponse = z.infer<typeof providerBeginResponse>;

export const providerCompleteBody = z.object({
  handoff: z.string().min(1).max(512),
  // The emailed code, when the provider did not vouch for the address.
  code: verificationCode.optional(),
  // Account details, when the provider identity matches no account and signup is allowed.
  signup: z.object({
    orgName: z.string().min(1).max(GENERAL_NAME_MAX_LENGTH).optional(),
    displayName: z.string().min(1).max(GENERAL_NAME_MAX_LENGTH),
  }).optional(),
});
export type ProviderCompleteBody = z.infer<typeof providerCompleteBody>;

// Why a provider round-trip ended without a session; the web app shows matching copy.
export const PROVIDER_SIGN_IN_ERRORS = [
  "cancelled",
  "expired",
  "failed",
  "email_missing",
  "account_unavailable",
  "signups_closed",
  "invalid_invite",
  "board_invite_email_mismatch",
  "identity_in_use",
  "provider_already_linked",
] as const;
export type ProviderSignInError = (typeof PROVIDER_SIGN_IN_ERRORS)[number];

export const signInMethodsResponse = z.object({
  hasPassword: z.boolean(),
  identities: z.array(z.object({
    provider: signInProviderSchema,
    email: z.string(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
  })),
});
export type SignInMethodsResponse = z.infer<typeof signInMethodsResponse>;
