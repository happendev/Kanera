import { dto } from "@kanera/shared";
import { standaloneBoardGroups } from "@kanera/shared/schema";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assertOrgRole } from "../../lib/access.js";
import { badRequest } from "../../lib/errors.js";
import { requestLocale } from "../../lib/i18n/request-locale.js";
import { issueUserSession, REFRESH_COOKIE, refreshCookieOptions } from "../../auth/session.js";
import { testClientSmtp, testClientStorage } from "./client-connection-tests.js";
import { ALLOWED_LOGO_MIME, deleteClientLogo, emitClientLogoChanged, MAX_LOGO_BYTES, uploadClientLogo } from "./client-logo.js";
import { cancelClientPlan, upgradeClientPlan } from "./client-plan.js";
import { loadClient } from "./client-queries.js";
import { createClient } from "./create-client.js";
import { deleteClient } from "./delete-client.js";
import { toPublicClient } from "./route-support.js";
import { assignStandaloneBoardGroup, emitStandaloneBoardGroupAssigned } from "./standalone-board-groups.js";
import { emitClientUpdated, updateClient } from "./update-client.js";

export async function clientRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post("/clients", async (req, reply) => {
    if (req.auth.authKind !== "user") throw badRequest("only user sessions can create an organisation");
    const body = dto.createClientBody.parse(req.body);
    const clientId = await createClient({ auth: req.auth, body });
    return issueUserSession(app, req.auth.sub, reply, clientId);
  });

  app.get("/clients/me", async (req) => {
    assertOrgRole(req.auth, "admin");
    const row = await loadClient(req.auth.cid);
    return toPublicClient(row);
  });

  app.get("/clients/me/standalone-board-groups", async (req) => {
    assertOrgRole(req.auth, "admin");
    return db.select().from(standaloneBoardGroups)
      .where(eq(standaloneBoardGroups.clientId, req.auth.cid))
      .orderBy(asc(standaloneBoardGroups.title));
  });

  app.patch("/clients/me/standalone-boards/:boardId/group", async (req) => {
    assertOrgRole(req.auth, "admin");
    const { boardId } = req.params as { boardId: string };
    const body = dto.assignStandaloneBoardGroupBody.parse(req.body);
    const result = await assignStandaloneBoardGroup({ auth: req.auth, boardId, body });
    await emitStandaloneBoardGroupAssigned({ auth: req.auth, result });
    return result.board;
  });

  app.patch("/clients/me", async (req) => {
    const body = dto.updateClientBody.parse(req.body);
    assertOrgRole(req.auth, "admin");
    const result = await updateClient({ auth: req.auth, body });
    await emitClientUpdated({ auth: req.auth, result });
    return toPublicClient(result.updated);
  });

  app.delete("/clients/me", async (req, reply) => {
    if (req.auth.authKind !== "user") throw badRequest("only user sessions can delete an organisation");
    assertOrgRole(req.auth, "owner");
    const body = dto.deleteClientBody.parse(req.body);
    const nextContext = await deleteClient({
      auth: req.auth,
      body,
      log: req.log,
      request: { id: req.id, method: req.method, url: req.url },
    });
    if (!nextContext.active) {
      reply.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
      return reply.status(202).send({ status: "logged_out" });
    }
    const session = await issueUserSession(app, req.auth.sub, reply, nextContext.active.clientId, nextContext);
    return reply.status(202).send(session);
  });

  app.post("/clients/me/smtp/test", async (req) => {
    const body = dto.testClientSmtpBody.parse(req.body);
    assertOrgRole(req.auth, "admin");
    return testClientSmtp({ auth: req.auth, body, locale: requestLocale(req) });
  });

  app.post("/clients/me/storage/test", async (req) => {
    const body = dto.testClientStorageBody.parse(req.body);
    assertOrgRole(req.auth, "admin");
    return testClientStorage({ auth: req.auth, body, log: req.log });
  });

  app.post("/clients/me/logo", async (req) => {
    assertOrgRole(req.auth, "admin");
    const file = await req.file({ limits: { fileSize: MAX_LOGO_BYTES, files: 1 } }).catch(() => null);
    if (!file) throw badRequest("no file uploaded");
    if (!ALLOWED_LOGO_MIME.has(file.mimetype)) throw badRequest("unsupported file type");

    const buffer = await file.toBuffer();
    if (buffer.byteLength > MAX_LOGO_BYTES) throw badRequest("file too large");

    const updated = await uploadClientLogo({ auth: req.auth, mimetype: file.mimetype, buffer, log: req.log });
    emitClientLogoChanged({ auth: req.auth, updated });
    return toPublicClient(updated);
  });

  app.delete("/clients/me/logo", async (req) => {
    assertOrgRole(req.auth, "admin");
    const updated = await deleteClientLogo({ auth: req.auth, log: req.log });
    emitClientLogoChanged({ auth: req.auth, updated });
    return toPublicClient(updated);
  });

  app.post("/clients/me/plan/upgrade", async (req) => {
    dto.upgradePlanBody.parse(req.body);
    assertOrgRole(req.auth, "admin");
    upgradeClientPlan();
  });

  app.post("/clients/me/plan/cancel", async (req) => {
    assertOrgRole(req.auth, "owner");
    cancelClientPlan();
  });
}
