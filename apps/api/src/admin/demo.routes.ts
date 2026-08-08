import type { AdminDemoResetResponse, AdminDemoStatus } from "@kanera/shared/dto";
import { adminAuditLogs, clients, oauthGrants, users, workspaceApiKeys, workspaces } from "@kanera/shared/schema";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { db, pool } from "../db.js";
import { conflict, forbidden } from "../lib/errors.js";
import {
  createStorageForConfig,
  getConfiguredS3StorageConfig,
  getStorageForClient,
  type StorageProvider,
} from "../lib/storage/index.js";
import {
  DEMO_SEED_LOGIN_EMAILS,
  DEMO_SEED_PRIMARY_EMAIL,
  seedDatabase,
} from "../scripts/seed-data.js";
import { writeAdminAudit } from "./audit.js";

const DEMO_RESET_LOCK_NAME = "kanera:admin-demo-reset";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireSuperadmin(req: FastifyRequest) {
  if (req.adminAuth.role !== "superadmin") throw forbidden("superadmin required");
}

async function findDemoClients() {
  const rows = await db
    .select({
      clientId: clients.id,
      name: clients.name,
      plan: clients.plan,
      billingStatus: clients.billingStatus,
      createdAt: clients.createdAt,
      email: users.email,
    })
    .from(users)
    .innerJoin(clients, eq(clients.id, users.clientId))
    .where(inArray(users.email, DEMO_SEED_LOGIN_EMAILS));

  const clientsById = new Map<string, {
    id: string;
    name: string;
    plan: string;
    billingStatus: string;
    createdAt: Date;
    emails: string[];
  }>();
  for (const row of rows) {
    const existing = clientsById.get(row.clientId);
    if (existing) {
      existing.emails.push(row.email);
    } else {
      clientsById.set(row.clientId, {
        id: row.clientId,
        name: row.name,
        plan: row.plan,
        billingStatus: row.billingStatus,
        createdAt: row.createdAt,
        emails: [row.email],
      });
    }
  }
  return [...clientsById.values()];
}

async function demoStatus(): Promise<AdminDemoStatus> {
  const organisations = await findDemoClients();
  const emails = new Set(organisations.flatMap((organisation) => organisation.emails));
  return {
    exists: emails.has(DEMO_SEED_PRIMARY_EMAIL),
    primaryEmail: DEMO_SEED_PRIMARY_EMAIL,
    userCount: emails.size,
    organisations: organisations.map(({ emails: _emails, ...organisation }) => ({
      ...organisation,
      createdAt: organisation.createdAt.toISOString(),
    })),
  };
}

async function pendingPurgeClientIds(): Promise<string[]> {
  const rows = await db
    .select({ action: adminAuditLogs.action, details: adminAuditLogs.details })
    .from(adminAuditLogs)
    .where(inArray(adminAuditLogs.action, ["demo.reset.started", "demo.reset"]));
  const completed = new Set(
    rows.flatMap((row) => {
      const details = row.details as Record<string, unknown> | null;
      const operationId = row.action === "demo.reset" ? details?.operationId : undefined;
      return typeof operationId === "string" ? [operationId] : [];
    }),
  );
  return [...new Set(rows.flatMap((row) => {
    if (row.action !== "demo.reset.started") return [];
    const details = row.details as Record<string, unknown> | null;
    const operationId = details?.operationId;
    if (typeof operationId !== "string" || completed.has(operationId)) return [];
    const clientIds = details?.existingClientIds;
    return Array.isArray(clientIds)
      ? clientIds.filter((id): id is string => typeof id === "string" && UUID_PATTERN.test(id))
      : [];
  }))];
}

async function withDemoResetLock<T>(run: () => Promise<T>): Promise<T> {
  const connection = await pool.connect();
  try {
    const result = await connection.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)) as locked",
      [DEMO_RESET_LOCK_NAME],
    );
    if (!result.rows[0]?.locked) throw conflict("a demo reset is already running");
    return await run();
  } finally {
    await connection.query("select pg_advisory_unlock(hashtext($1))", [DEMO_RESET_LOCK_NAME]).catch(() => undefined);
    connection.release();
  }
}

async function resetDemo(req: FastifyRequest): Promise<AdminDemoResetResponse> {
  return withDemoResetLock(async () => {
    const operationId = randomUUID();
    const existingClients = await findDemoClients();
    const existingClientIds = existingClients.map((client) => client.id);
    const clientIdsToPurge = [...new Set([...existingClientIds, ...await pendingPurgeClientIds()])];
    await db.transaction(async (tx) => {
      // Record the attempt before touching external storage so even a failed purge remains visible to
      // platform auditors. The completion event below records the new tenant IDs and seed totals.
      await writeAdminAudit(tx, {
        adminUserId: req.adminAuth.sub,
        action: "demo.reset.started",
        targetType: "demo",
        details: { operationId, existingClientIds: clientIdsToPurge },
      });
    });

    const storageByClient = new Map<string, StorageProvider>();
    for (const clientId of clientIdsToPurge) {
      storageByClient.set(
        clientId,
        existingClientIds.includes(clientId)
          ? await getStorageForClient(clientId)
          : createStorageForConfig(clientId, getConfiguredS3StorageConfig() ?? { kind: "local" }),
      );
    }

    // Purge the complete tenant namespace before dropping database metadata. This catches orphaned
    // uploads as well as live attachments, and retaining the client rows until every purge succeeds
    // means a failed S3/local deletion can be retried safely from the portal.
    await Promise.all([...storageByClient.values()].map((storage) => storage.deleteAll()));

    if (existingClientIds.length > 0) {
      await db.transaction(async (tx) => {
        // These issuance-organisation FKs intentionally do not cascade. Target the organisation,
        // not the creator: a user owned by another tenant can authorize a personal key or OAuth
        // grant while acting in the demo and will survive deletion of the demo-owned users.
        await tx.delete(oauthGrants).where(inArray(oauthGrants.orgClientId, existingClientIds));
        await tx.delete(workspaceApiKeys).where(inArray(workspaceApiKeys.clientId, existingClientIds));
        // Remove workspace-owned graphs while their users still exist. Many audit/creator FKs are
        // intentionally RESTRICT, so this ordering makes a whole-demo hard purge deterministic.
        await tx.delete(workspaces).where(inArray(workspaces.clientId, existingClientIds));
        await tx.delete(clients).where(inArray(clients.id, existingClientIds));
      });
    }

    // A second namespace purge closes the window for an upload that was already in flight when the
    // first purge began. Database ownership has now been removed, so no new demo write can commit.
    await Promise.all([...storageByClient.values()].map((storage) => storage.deleteAll()));

    const password = randomBytes(24).toString("base64url");
    const seeded = await seedDatabase({
      requireBlankDatabase: false,
      password,
      paid: true,
      analyticsExcluded: true,
    });

    await db.transaction(async (tx) => {
      await writeAdminAudit(tx, {
        adminUserId: req.adminAuth.sub,
        action: "demo.reset",
        targetType: "demo",
        targetClientId: seeded.primaryClientId,
        details: {
          operationId,
          replacedClientIds: existingClientIds,
          createdClientIds: [seeded.primaryClientId, seeded.guestClientId],
          users: seeded.summary.users,
          workspaces: seeded.summary.workspaces,
          boards: seeded.summary.boards,
          cards: seeded.summary.cards,
          attachments: seeded.summary.attachments,
        },
      });
    });

    return {
      ok: true,
      primaryEmail: DEMO_SEED_PRIMARY_EMAIL,
      password,
      loginEmails: DEMO_SEED_LOGIN_EMAILS,
      clientIds: [seeded.primaryClientId, seeded.guestClientId],
      summary: seeded.summary,
    };
  });
}

export async function adminDemoRoutes(app: FastifyInstance) {
  app.get("/demo", async (req) => {
    requireSuperadmin(req);
    return demoStatus();
  });

  app.post("/demo/reset", async (req) => {
    requireSuperadmin(req);
    return resetDemo(req);
  });
}
