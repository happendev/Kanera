import { dto } from "@kanera/shared";
import type { FastifyInstance } from "fastify";
import { notFound, unauthorized } from "../../lib/errors.js";
import {
  applyGitHubInstallationWebhook,
  applyGitHubPullRequestWebhook,
  githubWebhookSecret,
  verifyGitHubSignature,
} from "../../lib/github-webhooks.js";

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * GitHub App webhooks. Unauthenticated: the deployment's single App delivers for every
 * organisation, so a delivery is trusted only through its HMAC signature and is routed to an
 * organisation by its installation id.
 */
export async function githubWebhookRoutes(app: FastifyInstance) {
  app.post("/integrations/github/webhook", { config: { rawBody: true } }, async (req, reply) => {
    const secret = await githubWebhookSecret();
    if (!secret) throw notFound();
    if (typeof req.rawBody !== "string" || !verifyGitHubSignature(secret, req.rawBody, header(req.headers["x-hub-signature-256"]))) {
      throw unauthorized();
    }

    const event = header(req.headers["x-github-event"]);
    if (event === "pull_request") {
      // A payload Kanera cannot read is acknowledged rather than failed: GitHub would only
      // redeliver the same body, and nothing about it can change on retry.
      const parsed = dto.githubPullRequestWebhook.safeParse(req.body);
      if (parsed.success) await applyGitHubPullRequestWebhook(parsed.data);
      else req.log.warn({ issues: parsed.error.issues.slice(0, 5) }, "unreadable GitHub pull_request webhook");
    } else if (event === "installation" || event === "installation_repositories") {
      const parsed = dto.githubInstallationWebhook.safeParse(req.body);
      if (parsed.success) await applyGitHubInstallationWebhook(event, parsed.data);
    }
    return reply.status(202).send({ received: true });
  });
}
