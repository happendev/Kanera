import { clients } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { storageKeyFromMediaUrl, unsignedMediaUrl, withSignedMedia } from "../../lib/media-keys.js";
import { getStorageForClient } from "../../lib/storage/index.js";
import { orgLogoStorageKey } from "../../lib/storage/keys.js";
import { emitToClient } from "../../realtime/emit.js";
import { loadClient } from "./client-queries.js";
import type { ClientRow } from "./route-support.js";

export const ALLOWED_LOGO_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
const EXT_FOR_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** `POST /clients/me/logo`: stores the validated upload and replaces the previous logo object. */
export async function uploadClientLogo({ auth, mimetype, buffer, log }: { auth: AuthClaims; mimetype: string; buffer: Buffer; log: FastifyBaseLogger }): Promise<ClientRow> {
  const ext = EXT_FOR_MIME[mimetype] ?? "bin";
  const key = orgLogoStorageKey(ext);
  const storage = await getStorageForClient(auth.cid);

  const current = await loadClient(auth.cid);
  const prevKey = storageKeyFromMediaUrl(current.logoUrl, auth.cid);

  await storage.put(key, buffer, mimetype);
  const url = unsignedMediaUrl(auth.cid, key);

  const [updated] = await db
    .update(clients)
    .set({ logoUrl: url, updatedAt: new Date() })
    .where(eq(clients.id, auth.cid))
    .returning();

  if (prevKey && prevKey !== key) {
    await storage.delete(prevKey).catch((err: unknown) => log.warn({ err }, "failed to delete previous logo"));
  }

  return updated!;
}

/** `DELETE /clients/me/logo`: removes the stored logo object (best effort) and clears the URL. */
export async function deleteClientLogo({ auth, log }: { auth: AuthClaims; log: FastifyBaseLogger }): Promise<ClientRow> {
  const current = await loadClient(auth.cid);
  const key = storageKeyFromMediaUrl(current.logoUrl, auth.cid);
  if (key) {
    const storage = await getStorageForClient(auth.cid);
    await storage.delete(key).catch((err: unknown) => log.warn({ err }, "failed to delete logo"));
  }
  const [updated] = await db
    .update(clients)
    .set({ logoUrl: null, updatedAt: new Date() })
    .where(eq(clients.id, auth.cid))
    .returning();
  return updated!;
}

export function emitClientLogoChanged({ auth, updated }: { auth: AuthClaims; updated: ClientRow }) {
  emitToClient(auth.cid, "client:updated", withSignedMedia(auth.cid, { clientId: updated.id, name: updated.name, logoUrl: updated.logoUrl }));
}
