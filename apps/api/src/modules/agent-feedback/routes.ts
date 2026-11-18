import { dto } from "@kanera/shared";
import { clients, users } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { AppError, notFound, tooManyRequests } from "../../lib/errors.js";
import { sendInternalAgentFeedbackNotification } from "../../lib/internal-notification-emails.js";
import { applyRateLimitHeaders, FixedWindowRateLimiter } from "../../lib/rate-limit.js";

// Each report is an email to the team, so an agent stuck in a retry loop must not flood the inbox.
// Ten an hour per user is far above any genuine reporting pace.
const FEEDBACK_POLICY = { limit: 10, windowMs: 60 * 60_000 };
let limiter: FixedWindowRateLimiter | null = null;

function credentialLabel(auth: { authKind?: string; apiKeyName?: string; agentName?: string }) {
  if (auth.agentName) return `OAuth agent "${auth.agentName}"`;
  if (auth.authKind === "apiKey") return `API key "${auth.apiKeyName ?? "unnamed"}"`;
  return "Browser session";
}

export type SendAgentFeedback = typeof sendInternalAgentFeedbackNotification;

/**
 * Public API only. Lets an agent tell the Kanera team about errors, gaps or confusing behaviour it
 * hit. Hosted only: on a self-hosted install the operator is not the Kanera team, so the route does
 * not exist there.
 */
export async function agentFeedbackRoutes(app: FastifyInstance, options: { send?: SendAgentFeedback } = {}) {
  const send = options.send ?? sendInternalAgentFeedbackNotification;
  app.addHook("preHandler", app.authenticate);

  app.post("/feedback", async (req, reply) => {
    if (env.KANERA_DEPLOYMENT_MODE !== "hosted") throw notFound("feedback reporting is only available on Kanera Cloud");
    const body = dto.reportAgentFeedbackBody.parse(req.body);

    limiter ??= new FixedWindowRateLimiter();
    const limit = await limiter.check(`agent-feedback:${req.auth.sub}`, FEEDBACK_POLICY);
    applyRateLimitHeaders(reply, limit);
    if (!limit.allowed) throw tooManyRequests("feedback limit reached; try again later");

    const [[user], [organisation]] = await Promise.all([
      db.select({ displayName: users.displayName, email: users.email }).from(users).where(eq(users.id, req.auth.sub)).limit(1),
      db.select({ name: clients.name }).from(clients).where(eq(clients.id, req.auth.cid)).limit(1),
    ]);
    const sent = await send({
      ...body,
      credential: credentialLabel(req.auth),
      reporter: { userId: req.auth.sub, displayName: user?.displayName ?? "unknown", email: user?.email ?? "unknown" },
      orgName: organisation?.name ?? null,
      clientId: req.auth.cid,
    }, { log: req.log });
    // Internal alerts normally swallow delivery failures; here the email is the whole point, so the
    // agent must learn its report was lost rather than believe it arrived.
    if (sent === 0) throw new AppError(503, "FEEDBACK_UNAVAILABLE", "feedback could not be delivered right now");

    reply.code(202);
    return { received: true };
  });
}
