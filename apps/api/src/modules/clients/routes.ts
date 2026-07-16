import { dto } from "@kanera/shared";
import type { PublicClientResponse } from "@kanera/shared/dto";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { boardMembers, boards, clients, standaloneBoardGroups, users, workspaces, type SmtpConfig, type StorageConfig } from "@kanera/shared/schema";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { assertOrgRole } from "../../lib/access.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { recordActivity } from "../../lib/activity.js";
import { storageKeyFromMediaUrl, unsignedMediaUrl, withSignedMedia } from "../../lib/media-keys.js";
import {
  decryptSmtpConfig,
  decryptStorageConfig,
  encryptSmtpConfig,
  encryptStorageConfig,
  smtpConfigNeedsEncryption,
  storageConfigNeedsEncryption,
} from "../../lib/secrets.js";
import { mergeSmtpPassword, redactSmtpConfig, smtpConfigFromEnv, testSmtpConfig } from "../../lib/smtp.js";
import { createStorageForConfig, getConfiguredS3StorageConfig, getStorageForClient } from "../../lib/storage/index.js";
import { orgLogoStorageKey, storageProbeKey } from "../../lib/storage/keys.js";
import { getFreePlanLimits } from "../../lib/tier-limits.js";
import { ensureSystemWebPushConfig } from "../../lib/web-push.js";
import { boardRealtimeAudience, emitToBoardAudience, emitToClient, emitToClientDurable, emitToUserDurable } from "../../realtime/emit.js";

type ClientRow = typeof clients.$inferSelect;
type S3StorageConfig = Extract<StorageConfig, { kind: "s3" }>;

const REDACTED = "***";

function redact(config: StorageConfig | null): StorageConfig {
  if (!config || config.kind === "local") return { kind: "local" };
  return { ...config, accessKeyId: REDACTED, secretAccessKey: REDACTED };
}

function toPublicClient(row: ClientRow): PublicClientResponse {
  if (env.KANERA_DEPLOYMENT_MODE === "hosted") {
    return {
      id: row.id,
      name: row.name,
      logoUrl: withSignedMedia(row.id, { logoUrl: row.logoUrl }).logoUrl,
      deploymentMode: "hosted",
      pushEnabled: true,
      requireMfa: row.requireMfa,
      // Hosted deployments own SMTP/storage at the environment layer, so do not expose
      // provider details or redacted secrets to tenant admins.
      storageConfig: { kind: "local" },
      storageConfigSource: "env",
      smtpConfig: null,
      smtpConfigSource: null,
      proPricing: {
        monthlyCents: env.HOSTED_PRO_PRICE_MONTHLY_CENTS,
        annualCents: env.HOSTED_PRO_PRICE_ANNUAL_CENTS,
      },
      freePlanLimits: getFreePlanLimits(),
    };
  }

  const envSmtp = smtpConfigFromEnv();
  const smtpConfig = envSmtp ?? row.smtpConfig;
  const envStorageConfig = getConfiguredS3StorageConfig();
  const storageConfig = envStorageConfig ?? row.storageConfig;
  return {
    id: row.id,
    name: row.name,
    logoUrl: withSignedMedia(row.id, { logoUrl: row.logoUrl }).logoUrl,
    deploymentMode: "self_hosted",
    pushEnabled: row.pushEnabled,
    requireMfa: row.requireMfa,
    storageConfig: redact(storageConfig),
    storageConfigSource: envStorageConfig ? "env" : "client",
    smtpConfig: redactSmtpConfig(smtpConfig),
    smtpConfigSource: envSmtp ? "env" : row.smtpConfig ? "client" : null,
    proPricing: null,
    freePlanLimits: null,
  };
}

function resolveS3StorageConfig(incoming: S3StorageConfig, current: StorageConfig | null | undefined): S3StorageConfig {
  const existing = current?.kind === "s3" ? current : null;
  const accessKeyId = incoming.accessKeyId === REDACTED && existing ? existing.accessKeyId : incoming.accessKeyId;
  const secretAccessKey = incoming.secretAccessKey === REDACTED && existing ? existing.secretAccessKey : incoming.secretAccessKey;

  if (accessKeyId === REDACTED) {
    throw badRequest("accessKeyId required");
  }

  if (secretAccessKey === REDACTED) {
    throw badRequest("secretAccessKey required");
  }

  return {
    ...incoming,
    accessKeyId,
    secretAccessKey,
  };
}

async function loadClient(clientId: string): Promise<ClientRow> {
  const [row] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!row) throw notFound("client not found");

  const decrypted = {
    ...row,
    storageConfig: decryptStorageConfig(row.storageConfig) ?? null,
    smtpConfig: decryptSmtpConfig(row.smtpConfig) ?? null,
  };

  if (!storageConfigNeedsEncryption(row.storageConfig) && !smtpConfigNeedsEncryption(row.smtpConfig)) {
    return decrypted;
  }

  await db
    .update(clients)
    .set({
      storageConfig: encryptStorageConfig(decrypted.storageConfig),
      smtpConfig: encryptSmtpConfig(decrypted.smtpConfig),
    })
    .where(eq(clients.id, clientId));

  return decrypted;
}

async function externalBoardGuestUserIds(boardId: string, ownerClientId: string): Promise<string[]> {
  const rows = await db.selectDistinct({ userId: boardMembers.userId })
    .from(boardMembers)
    .innerJoin(users, and(eq(users.id, boardMembers.userId), ne(users.clientId, ownerClientId)))
    .where(eq(boardMembers.boardId, boardId));
  return rows.map((row) => row.userId);
}

const ALLOWED_LOGO_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
const EXT_FOR_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export async function clientRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

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
    const audience = await boardRealtimeAudience(boardId);
    const guestUserIds = await externalBoardGuestUserIds(boardId, req.auth.cid);
    const result = await db.transaction(async (tx) => {
      // Group names are the configuration surface. Serialize per organisation so two boards using
      // the same new name converge on one row even when saved concurrently.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${req.auth.cid}))`);
      const [current] = await tx.select({ board: boards, workspace: workspaces })
        .from(boards).innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
        .where(and(eq(boards.id, boardId), eq(workspaces.clientId, req.auth.cid))).limit(1);
      if (!current) throw notFound("board not found");
      if (current.workspace.kind !== "board") throw badRequest("board is not a standalone board");
      const [previousGroup] = current.board.standaloneGroupId
        ? await tx.select().from(standaloneBoardGroups).where(eq(standaloneBoardGroups.id, current.board.standaloneGroupId)).limit(1)
        : [];
      let group = null;
      if (body.groupTitle) {
        [group] = await tx.select().from(standaloneBoardGroups)
          .where(and(
            eq(standaloneBoardGroups.clientId, req.auth.cid),
            sql`lower(${standaloneBoardGroups.title}) = lower(${body.groupTitle})`,
          )).orderBy(asc(standaloneBoardGroups.createdAt)).limit(1);
        if (!group) {
          [group] = await tx.insert(standaloneBoardGroups).values({ clientId: req.auth.cid, title: body.groupTitle }).returning();
          await recordActivity(tx, {
            boardId: null, workspaceId: null, clientId: req.auth.cid, actorId: req.auth.sub,
            entityType: "standaloneBoardGroup", entityId: group!.id, action: "created", payload: { title: group!.title },
          });
        }
      }
      const [board] = await tx.update(boards).set({ standaloneGroupId: group?.id ?? null, updatedAt: new Date() })
        .where(eq(boards.id, boardId)).returning();
      await recordActivity(tx, {
        boardId, workspaceId: board!.workspaceId, clientId: req.auth.cid, actorId: req.auth.sub,
        entityType: "board", entityId: boardId, action: "updated",
        payload: { standaloneGroupId: group?.id ?? null, standaloneGroupTitle: group?.title ?? null, previousStandaloneGroupId: current.board.standaloneGroupId },
      });
      let deletedGroup = null;
      if (previousGroup && previousGroup.id !== group?.id) {
        const [countRow] = await tx.select({ count: sql<number>`count(*)::int` }).from(boards).where(eq(boards.standaloneGroupId, previousGroup.id));
        if ((countRow?.count ?? 0) === 0) {
          await tx.delete(standaloneBoardGroups).where(eq(standaloneBoardGroups.id, previousGroup.id));
          await recordActivity(tx, {
            boardId: null, workspaceId: null, clientId: req.auth.cid, actorId: req.auth.sub,
            entityType: "standaloneBoardGroup", entityId: previousGroup.id, action: "deleted", payload: { title: previousGroup.title },
          });
          deletedGroup = previousGroup;
        }
      }
      return { board: board!, group, deletedGroup };
    });
    if (result.deletedGroup) {
      await emitToClientDurable(req.auth.cid, SERVER_EVENTS.STANDALONE_BOARD_GROUP_DELETED, { clientId: req.auth.cid, groupId: result.deletedGroup.id });
      await Promise.all(guestUserIds.map((userId) => emitToUserDurable(userId, SERVER_EVENTS.STANDALONE_BOARD_GROUP_DELETED, { clientId: req.auth.cid, groupId: result.deletedGroup!.id })));
    }
    if (result.group) {
      await emitToClientDurable(req.auth.cid, SERVER_EVENTS.STANDALONE_BOARD_GROUP_UPSERTED, { group: result.group });
      await Promise.all(guestUserIds.map((userId) => emitToUserDurable(userId, SERVER_EVENTS.STANDALONE_BOARD_GROUP_UPSERTED, { group: result.group! })));
    }
    await emitToBoardAudience(boardId, SERVER_EVENTS.BOARD_UPDATED, { board: result.board }, { workspaceId: result.board.workspaceId, audienceUserIds: audience });
    return result.board;
  });

  app.patch("/clients/me", async (req) => {
    const body = dto.updateClientBody.parse(req.body);
    assertOrgRole(req.auth, "admin");

    const current = await loadClient(req.auth.cid);

    if (env.KANERA_DEPLOYMENT_MODE === "hosted" && body.pushEnabled === false) {
      throw badRequest("push messaging is managed by the hosted deployment");
    }

    let nextStorage: StorageConfig | null | undefined = undefined;
    if (body.storageConfig) {
      if (env.KANERA_DEPLOYMENT_MODE === "hosted") {
        throw badRequest("storage is configured by the hosted deployment");
      }
      if (getConfiguredS3StorageConfig()) {
        throw badRequest("storage is configured by environment variables");
      }
      if (body.storageConfig.kind === "local") {
        nextStorage = { kind: "local" };
      } else {
        nextStorage = resolveS3StorageConfig(body.storageConfig, current.storageConfig);
      }
    }

    let nextSmtp: SmtpConfig | null | undefined = undefined;
    if (body.smtpConfig !== undefined) {
      if (env.KANERA_DEPLOYMENT_MODE === "hosted") {
        throw badRequest("smtp is configured by the hosted deployment");
      }
      if (smtpConfigFromEnv()) {
        throw badRequest("smtp is configured by environment variables");
      }
      if (body.smtpConfig === null) {
        nextSmtp = null;
      } else {
        const existing = current.smtpConfig ?? smtpConfigFromEnv();
        nextSmtp = mergeSmtpPassword(body.smtpConfig, existing);
        if ((nextSmtp.username || existing?.username) && !nextSmtp.password) {
          throw badRequest("smtp password required");
        }
      }
    }

    if (body.pushEnabled === true && !current.pushEnabled) {
      await ensureSystemWebPushConfig();
    }

    const updates: Partial<typeof clients.$inferInsert> & { updatedAt: Date } = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.pushEnabled !== undefined) updates.pushEnabled = body.pushEnabled;
    if (body.requireMfa !== undefined) updates.requireMfa = body.requireMfa;
    if (nextStorage !== undefined) updates.storageConfig = encryptStorageConfig(nextStorage);
    if (nextSmtp !== undefined) updates.smtpConfig = encryptSmtpConfig(nextSmtp);

    const [updated] = await db.update(clients).set(updates).where(eq(clients.id, req.auth.cid)).returning();
    emitToClient(req.auth.cid, "client:updated", withSignedMedia(req.auth.cid, { clientId: updated!.id, name: updated!.name, logoUrl: updated!.logoUrl }));
    return toPublicClient(updated!);
  });

  app.post("/clients/me/smtp/test", async (req) => {
    const body = dto.testClientSmtpBody.parse(req.body);
    assertOrgRole(req.auth, "admin");
    if (env.KANERA_DEPLOYMENT_MODE === "hosted") {
      throw badRequest("smtp is configured by the hosted deployment");
    }
    const envConfig = smtpConfigFromEnv();
    if (envConfig) {
      await testSmtpConfig(envConfig, body.to);
      return { ok: true };
    }
    if (!body.smtpConfig) throw badRequest("smtpConfig required");
    const current = await loadClient(req.auth.cid);
    const config = mergeSmtpPassword(body.smtpConfig, current.smtpConfig ?? smtpConfigFromEnv());
    await testSmtpConfig(config, body.to);
    return { ok: true };
  });

  app.post("/clients/me/storage/test", async (req) => {
    const body = dto.testClientStorageBody.parse(req.body);
    assertOrgRole(req.auth, "admin");
    if (env.KANERA_DEPLOYMENT_MODE === "hosted") {
      throw badRequest("storage is configured by the hosted deployment");
    }

    const configuredS3 = getConfiguredS3StorageConfig();
    let storageConfig = configuredS3;
    if (!storageConfig) {
      if (!body.storageConfig) throw badRequest("storageConfig required");
      const current = await loadClient(req.auth.cid);
      storageConfig = resolveS3StorageConfig(body.storageConfig, current.storageConfig);
    }
    const storage = createStorageForConfig(req.auth.cid, storageConfig);
    const key = storageProbeKey();
    const probe = Buffer.alloc(1024, "k");

    await storage.put(key, probe, "text/plain");

    try {
      await storage.delete(key);
    } catch (err) {
      req.log.warn({ err, key }, "failed to delete storage test object");
      throw err;
    }

    return { ok: true };
  });

  app.post("/clients/me/logo", async (req) => {
    assertOrgRole(req.auth, "admin");
    const file = await req.file({ limits: { fileSize: MAX_LOGO_BYTES, files: 1 } }).catch(() => null);
    if (!file) throw badRequest("no file uploaded");
    if (!ALLOWED_LOGO_MIME.has(file.mimetype)) throw badRequest("unsupported file type");

    const buffer = await file.toBuffer();
    if (buffer.byteLength > MAX_LOGO_BYTES) throw badRequest("file too large");

    const ext = EXT_FOR_MIME[file.mimetype] ?? "bin";
    const key = orgLogoStorageKey(ext);
    const storage = await getStorageForClient(req.auth.cid);

    const current = await loadClient(req.auth.cid);
    const prevKey = storageKeyFromMediaUrl(current.logoUrl, req.auth.cid);

    await storage.put(key, buffer, file.mimetype);
    const url = unsignedMediaUrl(req.auth.cid, key);

    const [updated] = await db
      .update(clients)
      .set({ logoUrl: url, updatedAt: new Date() })
      .where(eq(clients.id, req.auth.cid))
      .returning();

    if (prevKey && prevKey !== key) {
      await storage.delete(prevKey).catch((err: unknown) => req.log.warn({ err }, "failed to delete previous logo"));
    }

    emitToClient(req.auth.cid, "client:updated", withSignedMedia(req.auth.cid, { clientId: updated!.id, name: updated!.name, logoUrl: updated!.logoUrl }));
    return toPublicClient(updated!);
  });

  app.delete("/clients/me/logo", async (req) => {
    assertOrgRole(req.auth, "admin");
    const current = await loadClient(req.auth.cid);
    const key = storageKeyFromMediaUrl(current.logoUrl, req.auth.cid);
    if (key) {
      const storage = await getStorageForClient(req.auth.cid);
      await storage.delete(key).catch((err: unknown) => req.log.warn({ err }, "failed to delete logo"));
    }
    const [updated] = await db
      .update(clients)
      .set({ logoUrl: null, updatedAt: new Date() })
      .where(eq(clients.id, req.auth.cid))
      .returning();
    emitToClient(req.auth.cid, "client:updated", withSignedMedia(req.auth.cid, { clientId: updated!.id, name: updated!.name, logoUrl: updated!.logoUrl }));
    return toPublicClient(updated!);
  });

  app.post("/clients/me/plan/upgrade", async (req) => {
    dto.upgradePlanBody.parse(req.body);
    assertOrgRole(req.auth, "admin");
    if (env.KANERA_DEPLOYMENT_MODE !== "hosted") {
      throw badRequest("plan changes are only available in hosted mode");
    }

    throw badRequest("use /billing/checkout to start a Stripe checkout session");
  });

  app.post("/clients/me/plan/cancel", async (req) => {
    assertOrgRole(req.auth, "owner");
    if (env.KANERA_DEPLOYMENT_MODE !== "hosted") {
      throw badRequest("plan changes are only available in hosted mode");
    }

    throw badRequest("use /billing/portal to manage or cancel a Stripe subscription");
  });
}
