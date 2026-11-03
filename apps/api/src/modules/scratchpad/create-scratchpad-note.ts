import type { dto } from "@kanera/shared";
import { MAX_SCRATCHPAD_NOTES, scratchpadNotes, type ScratchpadNote } from "@kanera/shared/schema";
import { and, desc, eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { badRequest } from "../../lib/errors.js";
import { stripSignedEmbeddedMediaUrls } from "../../lib/media-keys.js";
import { between } from "../../lib/position.js";
import { lockScratchpadForWrite } from "./route-support.js";

/** Creates a page at the end of the owner's tab list, enforcing the per-scratchpad page cap. */
export async function createScratchpadNote({
  auth,
  body,
}: {
  auth: AuthClaims;
  body: dto.CreateScratchpadNoteBody;
}): Promise<ScratchpadNote> {
  return db.transaction(async (tx) => {
    // A row lock cannot serialise the first create because an empty scratchpad has nothing to lock.
    // Every create takes this user-and-org-keyed advisory lock first, so concurrent tabs see one
    // authoritative count and last position even at the empty-list boundary, without serialising
    // writes to the same person's scratchpad in another organisation.
    await lockScratchpadForWrite(auth.sub, auth.cid, tx);
    const rows = await tx
      .select({ position: scratchpadNotes.position })
      .from(scratchpadNotes)
      .where(and(
        eq(scratchpadNotes.userId, auth.sub),
        eq(scratchpadNotes.clientId, auth.cid),
      ))
      .for("update")
      .orderBy(desc(scratchpadNotes.position));
    if (rows.length >= MAX_SCRATCHPAD_NOTES) {
      throw badRequest(`a scratchpad holds at most ${MAX_SCRATCHPAD_NOTES} pages`);
    }
    const { position } = between(rows[0]?.position ?? null, null);
    const [created] = await tx
      .insert(scratchpadNotes)
      .values({
        userId: auth.sub,
        clientId: auth.cid,
        title: body.title ?? "",
        content: stripSignedEmbeddedMediaUrls(body.content ?? "", auth.cid) ?? "",
        position,
      })
      .returning();
    return created!;
  });
}
