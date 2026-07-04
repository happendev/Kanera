import jwt, { type JWT } from "@fastify/jwt";
import { adminUsers, type AdminRole } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { db } from "../db.js";
import { env } from "../env.js";
import type { AuthClaims } from "../auth/plugin.js";
import { unauthorized } from "../lib/errors.js";

declare module "fastify" {
  interface FastifyInstance {
    adminAuthenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    adminAuth: AdminAuthClaims;
    // Registered by @fastify/jwt under the "admin" namespace (see jwtVerify option below). Verifies the
    // admin access token and resolves to its claims. Distinct from the tenant `jwtVerify` so a tenant
    // token can never be validated through this method.
    adminJwtVerify(): Promise<AdminAuthClaims>;
  }
}

// No `cid` — operating across every tenant is the entire point of the admin console. Role gates
// destructive vs. read/non-destructive actions at the route level.
export interface AdminAuthClaims {
  sub: string; // adminUserId
  role: AdminRole;
}

// The namespaced signer lives at `app.jwt.admin` at runtime; `app.jwt`'s published type does not include
// it, so widen locally rather than sprinkle casts. Used by the login/refresh routes to mint access tokens.
export function signAdminAccessToken(app: FastifyInstance, claims: AdminAuthClaims): string {
  // `JWT['sign']`'s payload type resolves to the tenant claims (the shared @fastify/jwt `FastifyJWT`
  // interface is declared once, by the tenant plugin), so type the admin namespace's signer explicitly.
  const adminJwt = (app.jwt as JWT & { admin: { sign: (payload: AdminAuthClaims) => string } }).admin;
  return adminJwt.sign(claims);
}

// Signs a *tenant* support-session token from the admin process. The admin server registers a second,
// default-namespace @fastify/jwt with the tenant JWT_SECRET (see below), so `app.jwt.sign` here produces
// a token the tenant API verifies exactly like one it minted itself. This is the one place the portal
// crosses into the tenant identity domain, and it is deliberate: the whole point of a support session is
// to enter a customer's workspace. The admin token stays isolated on `app.jwt.admin`.
export function signSupportToken(app: FastifyInstance, claims: AuthClaims, expiresInSeconds: number): string {
  // Signer lives at `app.jwt.tenant` (see the namespaced registration below); widen the type locally like
  // signAdminAccessToken does, since `app.jwt`'s published type does not include the namespace.
  const tenantJwt = (app.jwt as JWT & { tenant: { sign: (payload: AuthClaims, opts: { expiresIn: number }) => string } }).tenant;
  return tenantJwt.sign(claims, { expiresIn: expiresInSeconds });
}

export default fp(async (app) => {
  // The management portal is available in every deployment mode, but remains opt-in as a separate
  // process. Fail loudly if that process is started without its isolated signing secret.
  if (!env.ADMIN_JWT_SECRET) {
    throw new Error("ADMIN_JWT_SECRET is required to start the admin server");
  }

  app.register(jwt, {
    secret: env.ADMIN_JWT_SECRET,
    namespace: "admin",
    jwtVerify: "adminJwtVerify",
    jwtSign: "adminJwtSign",
    sign: { expiresIn: env.ADMIN_JWT_ACCESS_TTL },
  });

  // Second registration, under the "tenant" namespace, with the tenant JWT_SECRET so the admin process can
  // mint the tenant support-session token consumed by the web app (see signSupportToken). It must be
  // namespaced (not default): @fastify/jwt decorates request.user only once, and the "admin" registration
  // above already claimed it, so a default registration would collide. Verification of tenant tokens still
  // happens only on the tenant server; the admin server never authenticates a tenant token, so this widens
  // signing, not the admin auth boundary. admin-env asserts the two secrets differ.
  app.register(jwt, {
    secret: env.JWT_SECRET,
    namespace: "tenant",
    jwtVerify: "tenantJwtVerify",
    jwtSign: "tenantJwtSign",
  });

  app.decorate("adminAuthenticate", async (req: FastifyRequest) => {
    if (req.adminAuth) return;

    let claims: AdminAuthClaims;
    try {
      claims = await req.adminJwtVerify();
    } catch {
      throw unauthorized();
    }

    // Unlike the tenant guard (which trusts the short TTL and refresh revocation), re-check the account
    // on every request. A compromised admin token is cross-tenant catastrophic, so disabling or deleting
    // an admin must cut access within seconds — not wait out the access-token TTL.
    const [admin] = await db
      .select({ id: adminUsers.id, disabledAt: adminUsers.disabledAt })
      .from(adminUsers)
      .where(eq(adminUsers.id, claims.sub))
      .limit(1);
    if (!admin || admin.disabledAt) throw unauthorized();

    req.adminAuth = claims;
  });
});
