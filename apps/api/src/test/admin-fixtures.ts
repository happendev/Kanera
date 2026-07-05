import { adminUsers, type AdminRole } from "@kanera/shared/schema";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../auth/password.js";
import { db } from "../db.js";
import * as OTPAuth from "otpauth";

const ADMIN_REFRESH_COOKIE = "kanera_admin_rt";

// Inserts an admin_users row directly (bypassing the env-seed path) so tests control role + credentials.
export async function createAdmin(
  email: string,
  password: string,
  role: AdminRole = "superadmin",
): Promise<string> {
  const passwordHash = await hashPassword(password);
  const [row] = await db
    .insert(adminUsers)
    .values({ email, passwordHash, displayName: "Test Admin", role })
    .returning({ id: adminUsers.id });
  return row!.id;
}

export interface AdminSession {
  accessToken: string;
  refreshCookie: string;
}

// Logs an admin in via the real route and returns the access token + refresh cookie value.
export async function loginAdmin(app: FastifyInstance, email: string, password: string): Promise<AdminSession> {
  const res = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`admin login failed: ${res.statusCode} ${res.body}`);
  const challenge = res.json<{ status: string; challengeToken: string }>();
  if (challenge.status !== "mfa_enrollment_required") throw new Error(`unexpected admin auth state: ${res.body}`);
  const started = await app.inject({ method: "POST", url: "/admin/auth/mfa/enroll", payload: { challengeToken: challenge.challengeToken } });
  const setup = started.json<{ secret: string }>();
  const code = new OTPAuth.TOTP({ issuer: "Kanera", label: email, algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(setup.secret) }).generate();
  const completed = await app.inject({ method: "POST", url: "/admin/auth/mfa/enroll/confirm", payload: { challengeToken: challenge.challengeToken, code } });
  if (completed.statusCode !== 200) throw new Error(`admin MFA enrollment failed: ${completed.statusCode} ${completed.body}`);
  const acknowledged = await app.inject({ method: "POST", url: "/admin/auth/mfa/enroll/acknowledge", payload: { challengeToken: challenge.challengeToken } });
  if (acknowledged.statusCode !== 200) throw new Error(`admin recovery acknowledgement failed: ${acknowledged.statusCode} ${acknowledged.body}`);
  const cookie = acknowledged.cookies.find((c) => c.name === ADMIN_REFRESH_COOKIE);
  if (!cookie) throw new Error("admin login did not set refresh cookie");
  return { accessToken: acknowledged.json<{ accessToken: string }>().accessToken, refreshCookie: cookie.value };
}

export function adminAuthHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
