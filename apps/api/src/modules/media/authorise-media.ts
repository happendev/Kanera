import { cardAttachments, clients, noteAttachments, scratchpadNoteAttachments, users } from "@kanera/shared/schema";
import { eq, or } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { assertCardAccess } from "../../lib/access.js";
import { AppError, notFound } from "../../lib/errors.js";
import { parseMediaReference, unsignedMediaUrl } from "../../lib/media-keys.js";
import { authoriseRead, loadOrFail } from "../notes/route-support.js";
import { assertPersonalCredential, loadOwned } from "../scratchpad/route-support.js";

/** Renewing a bearer URL requires current resource authority, not just storage-tenant membership. */
export async function authoriseMedia(auth: AuthClaims, reference: { clientId: string; key: string }) {
  const { clientId, key } = reference;
  const ownsStorage = (url: string) => parseMediaReference(url)?.clientId === clientId;
  try {
    const [cardFile] = await db.select().from(cardAttachments).where(or(
      eq(cardAttachments.fileKey, key),
      eq(cardAttachments.thumbnailFileKey, key),
      eq(cardAttachments.coverImageFileKey, key),
    )).limit(1);
    if (cardFile && ownsStorage(cardFile.url)) {
      // Storage can belong to a guest uploader; board membership and assigned-item visibility
      // belong to the card's host organisation, independently of that storage namespace.
      await assertCardAccess(auth, cardFile.cardId);
      return;
    }
    const [noteFile] = await db.select().from(noteAttachments).where(eq(noteAttachments.fileKey, key)).limit(1);
    if (noteFile && ownsStorage(noteFile.url)) {
      await authoriseRead(auth, await loadOrFail(noteFile.noteId));
      return;
    }
    const [scratchpadFile] = await db.select().from(scratchpadNoteAttachments).where(eq(scratchpadNoteAttachments.fileKey, key)).limit(1);
    if (scratchpadFile && ownsStorage(scratchpadFile.url)) {
      assertPersonalCredential(auth);
      await loadOwned(scratchpadFile.scratchpadNoteId, auth);
      return;
    }
    // Avatars and organisation logos are shared identity images. Only renew the currently
    // published image, never arbitrary objects (or deleted images) in those namespaces.
    const url = unsignedMediaUrl(clientId, key)!;
    const [avatar] = await db.select({ id: users.id }).from(users).where(eq(users.avatarUrl, url)).limit(1);
    if (avatar) return;
    const [logo] = await db.select({ id: clients.id }).from(clients).where(eq(clients.logoUrl, url)).limit(1);
    if (logo) return;
  } catch (error) {
    // Keep resource existence and the reason for an access denial private on this endpoint.
    if (!(error instanceof AppError) || ![403, 404, 409].includes(error.statusCode)) throw error;
  }
  throw notFound();
}
