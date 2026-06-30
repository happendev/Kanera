import fp from "fastify-plugin";
import { db } from "../db.js";
import { env } from "../env.js";
import { createMailer, type Mailer } from "./mailer.js";
import { resolveSmtpConfig } from "./smtp-resolve.js";

declare module "fastify" {
  interface FastifyInstance {
    mailer: Mailer;
  }
}

export default fp(async (app) => {
  const mailer = createMailer({
    db,
    resolveSmtpConfig,
    webOrigin: env.WEB_ORIGIN,
    log: app.log,
  });

  app.decorate("mailer", mailer);
});
