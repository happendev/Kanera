import { AppError } from "./errors.js";
import type { StorageProvider } from "./storage/types.js";

/** Writes an upload to storage, mapping any provider failure to the 503 the clients retry on. */
export async function putAttachmentFile(storage: StorageProvider, key: string, body: Buffer, contentType: string) {
  try {
    await storage.put(key, body, contentType);
  } catch {
    throw new AppError(503, "STORAGE_UNAVAILABLE", "attachment storage unavailable");
  }
}
