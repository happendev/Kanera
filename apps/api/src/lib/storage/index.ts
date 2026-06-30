import { clients, type StorageConfig } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { decryptStorageConfig, encryptStorageConfig, storageConfigNeedsEncryption } from "../secrets.js";
import { createLocalStorage } from "./local.js";
import { createS3Storage } from "./s3.js";
import type { StorageProvider } from "./types.js";

export type { StorageProvider } from "./types.js";

export function createStorageForConfig(clientId: string, config: StorageConfig): StorageProvider {
  if (config.kind === "s3") return createS3Storage(clientId, config);
  return createLocalStorage(clientId);
}

export function getConfiguredS3StorageConfig(): Extract<StorageConfig, { kind: "s3" }> | null {
  if (!env.S3_REGION || !env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) return null;

  const config: Extract<StorageConfig, { kind: "s3" }> = {
    kind: "s3",
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  };
  if (env.S3_ENDPOINT) config.endpoint = env.S3_ENDPOINT;
  if (env.S3_PUBLIC_URL_PREFIX) config.publicUrlPrefix = env.S3_PUBLIC_URL_PREFIX;
  return config;
}

export async function getStorageForClient(clientId: string): Promise<StorageProvider> {
  const configuredS3 = getConfiguredS3StorageConfig();
  if (configuredS3) return createStorageForConfig(clientId, configuredS3);

  const [row] = await db
    .select({ storageConfig: clients.storageConfig })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  const config: StorageConfig = decryptStorageConfig(row?.storageConfig ?? { kind: "local" }) ?? { kind: "local" };
  if (row?.storageConfig && storageConfigNeedsEncryption(row.storageConfig)) {
    await db
      .update(clients)
      .set({ storageConfig: encryptStorageConfig(config) })
      .where(eq(clients.id, clientId));
  }
  return createStorageForConfig(clientId, config);
}
