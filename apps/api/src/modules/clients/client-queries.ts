import { boardMembers, clientMembers, clients } from "@kanera/shared/schema";
import { and, eq, notExists } from "drizzle-orm";
import { db } from "../../db.js";
import { notFound } from "../../lib/errors.js";
import {
  decryptSmtpConfig,
  decryptStorageConfig,
  encryptSmtpConfig,
  encryptStorageConfig,
  smtpConfigNeedsEncryption,
  storageConfigNeedsEncryption,
} from "../../lib/secrets.js";
import type { ClientRow } from "./route-support.js";

export async function loadClient(clientId: string): Promise<ClientRow> {
  const [row] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!row || row.deletedAt) throw notFound("client not found");

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

export async function externalBoardGuestUserIds(boardId: string, ownerClientId: string): Promise<string[]> {
  const rows = await db.selectDistinct({ userId: boardMembers.userId })
    .from(boardMembers)
    .where(and(
      eq(boardMembers.boardId, boardId),
      notExists(db.select({ userId: clientMembers.userId }).from(clientMembers).where(and(
        eq(clientMembers.clientId, ownerClientId),
        eq(clientMembers.userId, boardMembers.userId),
      ))),
    ));
  return rows.map((row) => row.userId);
}
