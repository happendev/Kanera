import { dto } from "@kanera/shared";
import type { Locale } from "@kanera/shared/locales";
import { authProviderFlows, clients, inviteTokens, userIdentities, users, type AuthProviderFlow, type SignInProvider } from "@kanera/shared/schema";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { notifyAccountSecurityChange } from "../../lib/account-security-notices.js";
import { resolveActiveOrganisationContext, type ActiveOrganisation } from "../../lib/client-membership.js";
import { cookieDomainAttribute } from "../../lib/cookie-domain.js";
import { AppError, conflict, forbidden, notFound, unauthorized } from "../../lib/errors.js";
import { requestLocale } from "../../lib/i18n/request-locale.js";
import { hashOpaqueToken, newOpaqueToken } from "../../lib/tokens.js";
import { announceCreatedAccount, assertEmailAvailableForSignup, createAccount, duplicateSignupMessage, isUniqueViolation, loadSignupBoardInvitation } from "../create-account.js";
import { createMfaChallenge, getMfaCredential } from "../mfa.js";
import { issueUserSession } from "../session.js";
import { generateCodeVerifier, generateState, signInProviderAdapter, type ProviderProfile } from "./adapters.js";

// Binds an attempt to the browser that started it; see auth_provider_flow.browser_nonce_hash.
const FLOW_COOKIE = "kanera_pf";
const FLOW_TTL_MS = 10 * 60_000;

/** What the callback resolved, stored server-side until the web app redeems the handoff. */
type FlowResult =
  | { step: "sign_in"; userId: string }
  | { step: "email_code"; userId: string | null; profile: ProviderProfile & { email: string } }
  | { step: "signup"; profile: ProviderProfile & { email: string } }
  | { step: "linked" };

class ProviderFlowError extends Error {
  constructor(public readonly reason: dto.ProviderSignInError) {
    super(reason);
  }
}

type ProviderRouteHelpers = {
  authRateLimit(action: string): preHandlerAsyncHookHandler;
  assertSignupOpenForIntent(params: { inviteToken?: string; boardInviteToken?: string }): Promise<void>;
  issueVerificationCode(params: { email: string; purpose: "identity_link"; userId: string | null; locale: Locale; log: FastifyBaseLogger }): Promise<void>;
  verifyAndConsumeCode(params: { email: string; purpose: "identity_link"; code: string; userId?: string | null }): Promise<void>;
  bootstrapOrganisationAfterFullDeletion(userId: string): Promise<{ active: ActiveOrganisation; organisations: ActiveOrganisation[] } | null>;
};

function flowCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    // Lax still sends it on the provider's top-level GET redirect back to the callback. Path "/" so
    // it reaches the callback whether the API is served at /auth (dev) or behind the /api proxy.
    sameSite: "lax" as const,
    secure: env.COOKIE_SECURE,
    domain: cookieDomainAttribute(env.COOKIE_DOMAIN),
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

function webCallbackUrl(params: Record<string, string>): string {
  return `${env.WEB_ORIGIN}/auth/callback?${new URLSearchParams(params).toString()}`;
}

function parseFlowResult(flow: AuthProviderFlow): FlowResult | null {
  return (flow.result as FlowResult | null) ?? null;
}

export async function providerAuthRoutes(app: FastifyInstance, helpers: ProviderRouteHelpers) {
  async function startFlow(reply: FastifyReply, params: {
    provider: SignInProvider;
    intent: "login" | "link";
    linkUserId?: string;
    body: dto.ProviderSignInBeginBody;
  }): Promise<dto.ProviderBeginResponse> {
    const adapter = signInProviderAdapter(params.provider);
    if (!adapter) throw notFound("sign-in provider not available");
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const nonce = newOpaqueToken();
    await db.insert(authProviderFlows).values({
      provider: params.provider,
      intent: params.intent,
      stateHash: hashOpaqueToken(state),
      browserNonceHash: nonce.hash,
      codeVerifier,
      linkUserId: params.linkUserId ?? null,
      inviteToken: params.body.inviteToken ?? null,
      boardInviteToken: params.body.boardInviteToken ?? null,
      returnUrl: params.body.returnUrl ?? null,
      locale: params.body.locale ?? null,
      analyticsAttribution: params.body.analyticsAttribution ?? null,
      expiresAt: new Date(Date.now() + FLOW_TTL_MS),
    });
    reply.setCookie(FLOW_COOKIE, nonce.raw, flowCookieOptions(FLOW_TTL_MS / 1000));
    return { authorizeUrl: adapter.authorizationUrl(state, codeVerifier).toString() };
  }

  function browserOwnsFlow(req: FastifyRequest, flow: AuthProviderFlow): boolean {
    const nonce = req.cookies[FLOW_COOKIE];
    return !!nonce && hashOpaqueToken(nonce) === flow.browserNonceHash;
  }

  async function consumeFlow(reply: FastifyReply, flowId: string): Promise<boolean> {
    const consumed = await db
      .update(authProviderFlows)
      .set({ consumedAt: new Date() })
      .where(and(eq(authProviderFlows.id, flowId), isNull(authProviderFlows.consumedAt)))
      .returning({ id: authProviderFlows.id });
    reply.clearCookie(FLOW_COOKIE, flowCookieOptions(0));
    return consumed.length > 0;
  }

  /**
   * Attaches a provider identity to an account. Matching later sign-ins on the provider's stable
   * subject (never the email) means a provider address that is reassigned cannot reach this account.
   */
  async function linkIdentity(userId: string, provider: SignInProvider, profile: ProviderProfile & { email: string }, log: FastifyBaseLogger) {
    try {
      await db.transaction(async (tx) => {
        await tx.insert(userIdentities).values({
          userId,
          provider,
          providerSubject: profile.subject,
          email: profile.email,
          lastUsedAt: new Date(),
        });
        // The provider (or the emailed code) has just proven this mailbox, which is the account's email.
        await tx.update(users).set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt), sql`lower(${users.email}) = lower(${profile.email})`));
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ProviderFlowError("provider_already_linked");
      throw err;
    }
    // Linking is silent at sign-in, so the owner hears about every new way into their account.
    await notifyAccountSecurityChange(app.mailer, { userId, event: "sign_in_method_added", provider, log });
  }

  async function assertProviderSignupAllowed(flow: AuthProviderFlow, email: string) {
    try {
      await helpers.assertSignupOpenForIntent({ inviteToken: flow.inviteToken ?? undefined, boardInviteToken: flow.boardInviteToken ?? undefined });
    } catch (err) {
      if (err instanceof AppError) throw new ProviderFlowError(err.statusCode === 403 ? "signups_closed" : "invalid_invite");
      throw err;
    }
    try {
      await loadSignupBoardInvitation({ email, inviteToken: flow.inviteToken, boardInviteToken: flow.boardInviteToken });
    } catch (err) {
      if (err instanceof AppError) throw new ProviderFlowError(err.code === "BOARD_INVITE_EMAIL_MISMATCH" ? "board_invite_email_mismatch" : "invalid_invite");
      throw err;
    }
  }

  async function resolveCallback(flow: AuthProviderFlow, profile: ProviderProfile, req: FastifyRequest): Promise<FlowResult> {
    const provider = flow.provider;
    const [linked] = await db
      .select({ userId: userIdentities.userId, deletedAt: users.deletedAt })
      .from(userIdentities)
      .innerJoin(users, eq(users.id, userIdentities.userId))
      .where(and(eq(userIdentities.provider, provider), eq(userIdentities.providerSubject, profile.subject)))
      .limit(1);

    if (flow.intent === "link") {
      if (linked) {
        if (linked.userId !== flow.linkUserId) throw new ProviderFlowError("identity_in_use");
        return { step: "linked" };
      }
      await linkIdentity(flow.linkUserId!, provider, { ...profile, email: profile.email ?? "" }, req.log);
      return { step: "linked" };
    }

    if (linked) {
      if (linked.deletedAt) throw new ProviderFlowError("account_unavailable");
      await db.update(userIdentities).set({ lastUsedAt: new Date() })
        .where(and(eq(userIdentities.provider, provider), eq(userIdentities.providerSubject, profile.subject)));
      return { step: "sign_in", userId: linked.userId };
    }

    if (!profile.email) throw new ProviderFlowError("email_missing");
    const withEmail = { ...profile, email: profile.email };
    const locale = flow.locale ?? requestLocale(req);
    const [existing] = await db
      .select({ id: users.id, email: users.email, deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.email, profile.email))
      .limit(1);
    if (existing) {
      if (existing.deletedAt) throw new ProviderFlowError("account_unavailable");
      // Product rule: a provider-verified address that matches an account links automatically. An
      // address the provider does not vouch for must be proven with a Kanera code first, or anyone
      // able to type an address into a provider profile could sign in as its owner.
      if (profile.emailVerified) {
        await linkIdentity(existing.id, provider, withEmail, req.log);
        return { step: "sign_in", userId: existing.id };
      }
      await helpers.issueVerificationCode({ email: existing.email, purpose: "identity_link", userId: existing.id, locale, log: req.log });
      return { step: "email_code", userId: existing.id, profile: withEmail };
    }

    await assertProviderSignupAllowed(flow, profile.email);
    if (!profile.emailVerified) {
      await helpers.issueVerificationCode({ email: profile.email, purpose: "identity_link", userId: null, locale, log: req.log });
      return { step: "email_code", userId: null, profile: withEmail };
    }
    return { step: "signup", profile: withEmail };
  }

  async function signInExistingUser(reply: FastifyReply, flow: AuthProviderFlow, userId: string) {
    const [user] = await db
      .select({ deletedAt: users.deletedAt, needsOrganisationOnLoginAt: users.needsOrganisationOnLoginAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user || user.deletedAt) throw unauthorized("invalid credentials");
    // The provider satisfies an organisation's MFA requirement, but a factor the user turned on for
    // their own account is still theirs to answer. The challenge keeps the provider as the method.
    const credential = await getMfaCredential({ kind: "user", id: userId });
    if (credential?.enabledAt) {
      return { status: "mfa_required" as const, challengeToken: createMfaChallenge({ kind: "user", id: userId }, "verify", flow.provider), returnUrl: flow.returnUrl };
    }
    let context = await resolveActiveOrganisationContext(userId);
    if (!context.active && user.needsOrganisationOnLoginAt) {
      context = await helpers.bootstrapOrganisationAfterFullDeletion(userId) ?? context;
    }
    if (!context.active) throw unauthorized("no active organisation membership");
    const session = await issueUserSession(app, userId, reply, context.active.clientId, context, flow.provider);
    return { ...session, returnUrl: flow.returnUrl };
  }

  async function signupDetails(flow: AuthProviderFlow, profile: ProviderProfile & { email: string }) {
    const [invite] = flow.inviteToken
      ? await db
        .select({ orgName: clients.name })
        .from(inviteTokens)
        .innerJoin(clients, eq(clients.id, inviteTokens.clientId))
        .where(and(
          eq(inviteTokens.tokenHash, hashOpaqueToken(flow.inviteToken)),
          isNull(inviteTokens.revokedAt),
          sql`(${inviteTokens.expiresAt} is null or ${inviteTokens.expiresAt} > now())`,
        ))
        .limit(1)
      : [];
    return {
      status: "signup_details_required" as const,
      email: profile.email,
      displayName: profile.displayName,
      // Invited people join an existing organisation (or a board host), so the form skips the name.
      joiningOrganisation: invite?.orgName ?? null,
      boardInvite: !!flow.boardInviteToken && !invite,
    };
  }

  async function createProviderAccount(req: FastifyRequest, reply: FastifyReply, flow: AuthProviderFlow, profile: ProviderProfile & { email: string }, signup: NonNullable<dto.ProviderCompleteBody["signup"]>) {
    // Re-checked at creation: signups may have closed or the invite been revoked since the callback.
    try {
      await assertProviderSignupAllowed(flow, profile.email);
    } catch (err) {
      if (err instanceof ProviderFlowError) throw new AppError(403, "PROVIDER_SIGN_IN_FAILED", "This sign-in can't create an account.", { reason: err.reason });
      throw err;
    }
    const boardInvitation = await loadSignupBoardInvitation({ email: profile.email, inviteToken: flow.inviteToken, boardInviteToken: flow.boardInviteToken });
    await assertEmailAvailableForSignup({ email: profile.email, inviteToken: flow.inviteToken, boardInvitation });
    const attribution = flow.analyticsAttribution
      ? dto.providerSignInBeginBody.shape.analyticsAttribution.safeParse(flow.analyticsAttribution).data
      : undefined;
    let result;
    try {
      result = await createAccount({
        email: profile.email,
        emailVerified: true,
        passwordHash: null,
        displayName: signup.displayName,
        orgName: signup.orgName ?? "Private",
        locale: flow.locale,
        inviteToken: flow.inviteToken,
        boardInviteToken: flow.boardInviteToken,
        boardInvitation,
        analyticsAttribution: attribution,
        identity: { provider: flow.provider, subject: profile.subject, email: profile.email },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(duplicateSignupMessage(flow));
      throw err;
    }
    await consumeFlow(reply, flow.id);
    await announceCreatedAccount(app, result, {
      analyticsAttribution: attribution,
      signInMethod: flow.provider,
      fallbackLocale: requestLocale(req),
      log: req.log,
    });
    // A provider session satisfies any MFA policy of an invited organisation, so this always signs in.
    const session = await issueUserSession(app, result.user.id, reply, result.user.clientId, undefined, flow.provider);
    if (session.status !== "authenticated") return session;
    // The invitation this signup carried has been accepted, so a return to its acceptance page is moot.
    const returnUrl = result.acceptedInvite || result.redeemedInvite ? null : flow.returnUrl;
    return { ...session, user: { ...session.user, boardInviteRedirect: result.boardInviteRedirect }, returnUrl };
  }

  app.post("/auth/providers/:provider/begin", { preHandler: helpers.authRateLimit("provider-begin") }, async (req, reply) => {
    const { provider } = dto.signInProviderParams.parse(req.params);
    const body = dto.providerSignInBeginBody.parse(req.body ?? {});
    return startFlow(reply, { provider, intent: "login", body });
  });

  // The provider redirects the browser here. It resolves who is signing in but never issues a
  // session itself: it hands a one-time code back to the web app, which redeems it with fetch so the
  // access token stays in memory and the refresh cookie is set exactly as password login sets it.
  app.get("/auth/providers/:provider/callback", async (req, reply) => {
    const { provider } = dto.signInProviderParams.parse(req.params);
    const query = z.object({
      code: z.string().max(4096).optional(),
      state: z.string().max(512).optional(),
      error: z.string().max(256).optional(),
    }).parse(req.query);
    const fail = (error: dto.ProviderSignInError, intent?: string) =>
      reply.redirect(webCallbackUrl(intent === "link" ? { error, intent } : { error }));

    if (!query.state) return fail("expired");
    const [flow] = await db
      .select()
      .from(authProviderFlows)
      .where(and(
        eq(authProviderFlows.stateHash, hashOpaqueToken(query.state)),
        eq(authProviderFlows.provider, provider),
        isNull(authProviderFlows.consumedAt),
        isNull(authProviderFlows.handoffHash),
        gt(authProviderFlows.expiresAt, new Date()),
      ))
      .limit(1);
    if (!flow || !browserOwnsFlow(req, flow)) return fail("expired", flow?.intent);

    // Claim the attempt before calling the provider so a replayed callback cannot run it twice.
    const handoff = newOpaqueToken();
    const claimed = await db
      .update(authProviderFlows)
      .set({ handoffHash: handoff.hash })
      .where(and(eq(authProviderFlows.id, flow.id), isNull(authProviderFlows.handoffHash)))
      .returning({ id: authProviderFlows.id });
    if (claimed.length === 0) return fail("expired", flow.intent);

    const adapter = signInProviderAdapter(provider);
    if (query.error || !query.code || !adapter) {
      await consumeFlow(reply, flow.id);
      return fail(query.error || !query.code ? "cancelled" : "failed", flow.intent);
    }
    let result: FlowResult;
    try {
      const profile = await adapter.exchange(query.code, flow.codeVerifier);
      result = await resolveCallback(flow, profile, req);
    } catch (err) {
      await consumeFlow(reply, flow.id);
      if (err instanceof ProviderFlowError) return fail(err.reason, flow.intent);
      req.log.warn({ err, provider }, "provider sign-in failed");
      return fail("failed", flow.intent);
    }
    await db.update(authProviderFlows).set({ result }).where(eq(authProviderFlows.id, flow.id));
    return reply.redirect(webCallbackUrl(flow.intent === "link" ? { h: handoff.raw, intent: "link" } : { h: handoff.raw }));
  });

  app.post("/auth/providers/complete", { preHandler: helpers.authRateLimit("provider-complete") }, async (req, reply) => {
    const body = dto.providerCompleteBody.parse(req.body);
    const [flow] = await db
      .select()
      .from(authProviderFlows)
      .where(and(
        eq(authProviderFlows.handoffHash, hashOpaqueToken(body.handoff)),
        isNull(authProviderFlows.consumedAt),
        gt(authProviderFlows.expiresAt, new Date()),
      ))
      .limit(1);
    let result = flow ? parseFlowResult(flow) : null;
    if (!flow || !result || !browserOwnsFlow(req, flow)) {
      throw new AppError(401, "PROVIDER_SIGN_IN_EXPIRED", "This sign-in has expired. Start again.");
    }

    if (result.step === "email_code") {
      if (!body.code) return { status: "email_code_required" as const, email: result.profile.email };
      await helpers.verifyAndConsumeCode({ email: result.profile.email, purpose: "identity_link", code: body.code, userId: result.userId });
      if (result.userId) {
        try {
          await linkIdentity(result.userId, flow.provider, result.profile, req.log);
        } catch (err) {
          if (err instanceof ProviderFlowError) {
            await consumeFlow(reply, flow.id);
            throw new AppError(409, "PROVIDER_SIGN_IN_FAILED", "This sign-in can't be linked to your account.", { reason: err.reason });
          }
          throw err;
        }
        result = { step: "sign_in", userId: result.userId };
      } else {
        result = { step: "signup", profile: { ...result.profile, emailVerified: true } };
      }
      await db.update(authProviderFlows).set({ result }).where(eq(authProviderFlows.id, flow.id));
    }

    if (result.step === "linked") {
      if (!(await consumeFlow(reply, flow.id))) throw new AppError(401, "PROVIDER_SIGN_IN_EXPIRED", "This sign-in has expired. Start again.");
      return { status: "linked" as const, provider: flow.provider, returnUrl: flow.returnUrl };
    }
    if (result.step === "signup") {
      if (!body.signup) return signupDetails(flow, result.profile);
      return createProviderAccount(req, reply, flow, result.profile, body.signup);
    }
    if (!(await consumeFlow(reply, flow.id))) throw new AppError(401, "PROVIDER_SIGN_IN_EXPIRED", "This sign-in has expired. Start again.");
    return signInExistingUser(reply, flow, result.userId);
  });

  app.get("/auth/me/sign-in-methods", { preHandler: app.authenticate }, async (req): Promise<dto.SignInMethodsResponse> => {
    const [me] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, req.auth.sub)).limit(1);
    if (!me) throw unauthorized();
    const identities = await db
      .select({ provider: userIdentities.provider, email: userIdentities.email, createdAt: userIdentities.createdAt, lastUsedAt: userIdentities.lastUsedAt })
      .from(userIdentities)
      .where(eq(userIdentities.userId, req.auth.sub))
      .orderBy(asc(userIdentities.createdAt));
    return {
      hasPassword: !!me.passwordHash,
      identities: identities.map((identity) => ({
        ...identity,
        createdAt: identity.createdAt.toISOString(),
        lastUsedAt: identity.lastUsedAt?.toISOString() ?? null,
      })),
    };
  });

  app.post("/auth/me/identities/:provider/begin", { preHandler: [app.authenticate, helpers.authRateLimit("provider-begin")] }, async (req, reply) => {
    if (req.auth.authKind !== "user") throw forbidden();
    const { provider } = dto.signInProviderParams.parse(req.params);
    const body = dto.providerSignInBeginBody.pick({ returnUrl: true }).parse(req.body ?? {});
    return startFlow(reply, { provider, intent: "link", linkUserId: req.auth.sub, body });
  });

  app.delete("/auth/me/identities/:provider", { preHandler: app.authenticate }, async (req) => {
    if (req.auth.authKind !== "user") throw forbidden();
    const { provider } = dto.signInProviderParams.parse(req.params);
    const removed = await db.transaction(async (tx) => {
      // Serialise against a concurrent disconnect of the other method on the same account.
      const [me] = await tx.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, req.auth.sub)).limit(1).for("update");
      if (!me) throw unauthorized();
      const identities = await tx.select({ provider: userIdentities.provider }).from(userIdentities).where(eq(userIdentities.userId, req.auth.sub));
      if (!identities.some((identity) => identity.provider === provider)) throw notFound("sign-in method not found");
      if (!me.passwordHash && identities.length === 1) {
        throw new AppError(409, "LAST_SIGN_IN_METHOD", "Set a password or connect another sign-in method before removing this one.");
      }
      await tx.delete(userIdentities).where(and(eq(userIdentities.userId, req.auth.sub), eq(userIdentities.provider, provider)));
      return true;
    });
    if (removed) await notifyAccountSecurityChange(app.mailer, { userId: req.auth.sub, event: "sign_in_method_removed", provider, log: req.log });
    return { ok: true };
  });
}
