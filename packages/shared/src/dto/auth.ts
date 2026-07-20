import { z } from "zod";
import { GENERAL_NAME_MAX_LENGTH } from "./name-limits.js";

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

export const signupBody = z.object({
  orgName: z.string().min(1).max(GENERAL_NAME_MAX_LENGTH).default("Private"),
  email: z.email().max(254),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(GENERAL_NAME_MAX_LENGTH),
  inviteToken: z.string().min(1).optional(),
  boardInviteToken: z.string().min(1).optional(),
  // Acquisition values are allow-listed, bounded marketing categories used only for the
  // registration_completed event. They are never copied into account or organisation models.
  analyticsAttribution: z.object({
    source: z.string().trim().min(1).max(120),
    medium: z.string().trim().min(1).max(120),
    campaign: z.string().trim().min(1).max(120),
  }).optional(),
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
  kaneraEnvironment: z.enum(["development", "test", "staging", "production"]),
  deploymentMode: z.enum(["self_hosted", "hosted"]),
  analytics: z.object({
    enabled: z.literal(true),
    provider: z.literal("posthog"),
    projectKey: z.string().min(1),
    apiHost: z.url(),
  }).nullable(),
});
export type AuthConfigResponse = z.infer<typeof authConfigResponse>;

export const loginBody = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export type LoginBody = z.infer<typeof loginBody>;

export const mfaCode = z.string().trim().min(6).max(32);
export const mfaChallengeBody = z.object({ challengeToken: z.string().min(1), code: mfaCode });
export const mfaEnrollmentStartBody = z.object({ currentPassword: z.string().min(1) });
export const mfaEnrollmentConfirmBody = z.object({ code: mfaCode });
export const mfaProtectedActionBody = z.object({ currentPassword: z.string().min(1), code: mfaCode });
export const mfaChallengeResponse = z.object({ status: z.literal("mfa_required"), challengeToken: z.string() });
export const mfaEnrollmentResponse = z.object({ status: z.literal("mfa_enrollment_required"), challengeToken: z.string() });
export type MfaChallengeBody = z.infer<typeof mfaChallengeBody>;
export type MfaProtectedActionBody = z.infer<typeof mfaProtectedActionBody>;

export const authResponse = z.object({
  accessToken: z.string(),
  user: z.object({
    id: z.uuid(),
    clientId: z.uuid(),
    email: z.email(),
    displayName: z.string(),
    avatarUrl: z.string().nullable(),
    timezone: z.string(),
    orgName: z.string(),
    logoUrl: z.string().nullable(),
    deploymentMode: z.enum(["self_hosted", "hosted"]),
    kaneraEnvironment: z.enum(["development", "test", "staging", "production"]),
    hasWorkspace: z.boolean(),
    isClientAdmin: z.boolean(),
    storageUsage: storageUsageResponse,
    analyticsExcluded: z.boolean(),
    boardInviteRedirect: z.string().nullable().optional(),
  }),
});
export type AuthResponse = z.infer<typeof authResponse>;

export const forgotPasswordBody = z.object({
  email: z.email(),
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

export const meResponse = authResponse.shape.user;
export type MeResponse = z.infer<typeof meResponse>;

// Email is intentionally absent: changing it goes through POST /auth/me/email,
// with a verification code required only when the deployment enables it.
export const updateMeBody = z.object({
  displayName: z.string().min(1).max(GENERAL_NAME_MAX_LENGTH).optional(),
  timezone: z.string().min(1).max(100).optional(),
});
export type UpdateMeBody = z.infer<typeof updateMeBody>;

export const changePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});
export type ChangePasswordBody = z.infer<typeof changePasswordBody>;
